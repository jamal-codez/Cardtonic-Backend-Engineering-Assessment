import { Inject, Injectable } from '@nestjs/common';
import { inArray } from 'drizzle-orm';
import { APP_CONFIG, type AppConfig } from '../../common/config/config';
import { wallets } from '../../common/db/schema';
import type { Db } from '../../common/db/with-transaction';
import { AppError } from '../../common/errors/app-error';
import { CURRENCY_CODES, parseCurrency, type CurrencyCode } from '../../common/money/currency';
import { formatAmount, parseAmount } from '../../common/money/money';
import {
  IdempotencyService,
  type ExecuteResult,
  type WorkResult,
} from '../../idempotency/idempotency.service';
import { hashRequest } from '../../idempotency/request-hash';
import { LedgerService } from '../../ledger/ledger.service';
import { ConversionService, type ConversionQuote } from '../conversion/conversion.service';
import { toPaymentResource } from '../payment.mapper';
import { QuotesService } from '../quotes/quotes.service';
import type { CreateTransferDto } from './dto/create-transfer.dto';

type ResolvedQuote = { ok: true; quote: ConversionQuote } | { ok: false; error: unknown };

interface TransferPlan {
  senderId: string;
  receiverId: string;
  source: CurrencyCode;
  destination: CurrencyCode;
  amount: bigint;
  /** Null for a same-currency transfer, which never involves FX. */
  conversion: ResolvedQuote | null;
  /** A quote to consume instead of pricing (cross-currency only). */
  quoteId: string | null;
}

/**
 * Sends coins from one wallet to another inside one database transaction, converting when the
 * currencies differ. Both wallets live in the same database, so one ACID transaction is the whole
 * design: no saga, outbox or retry worker.
 *
 * This class deliberately never imports the fx module. Same-currency transfers do not call the
 * conversion service at all.
 */
@Injectable()
export class TransfersService {
  constructor(
    private readonly idempotency: IdempotencyService,
    private readonly ledger: LedgerService,
    private readonly conversion: ConversionService,
    private readonly quotes: QuotesService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  transfer(
    senderId: string,
    dto: CreateTransferDto,
    key: string,
    requestId: string,
  ): Promise<ExecuteResult> {
    // Validation first, outside the idempotency boundary: validation errors are never stored.
    const receiverId = dto.to_wallet_id.toLowerCase();
    if (receiverId === senderId) {
      // Converting inside one wallet is what a swap is for, so this is refused in any currency.
      throw new AppError('SELF_TRANSFER', { detail: 'to_wallet_id must differ from the sender' });
    }
    const source = parseCurrency(dto.source_currency);
    const destination = parseCurrency(dto.destination_currency ?? dto.source_currency);
    const amount = parseAmount(dto.amount, this.config.MAX_TX_AMOUNT);
    const quoteId = dto.quote_id?.toLowerCase() ?? null;
    if (quoteId && source === destination) {
      // A same-currency transfer never involves FX, so there is nothing a quote could lock.
      throw new AppError('VALIDATION_ERROR', {
        detail: 'quote_id applies to cross-currency transfers only',
      });
    }

    const scope = `wallet:${senderId}:POST /v1/wallets/:id/transfers`;
    const requestHash = hashRequest(scope, {
      to_wallet_id: receiverId,
      source_currency: source,
      destination_currency: destination,
      amount: formatAmount(amount),
      // Only when present, so the hash of a transfer without a quote is unchanged.
      ...(quoteId ? { quote_id: quoteId } : {}),
    });

    // Cross-currency only: resolve the rate before any database transaction opens. Its failure is
    // carried into the idempotency work (see SwapsService), so dust is stored against the key and
    // an FX outage releases it. A same-currency transfer skips this entirely.
    const plan: TransferPlan = {
      senderId,
      receiverId,
      source,
      destination,
      amount,
      conversion:
        source === destination || quoteId ? null : this.resolveQuote(source, destination, amount),
      quoteId,
    };

    return this.idempotency.execute(scope, key, requestHash, (tx) => this.work(tx, plan, key), {
      requestId,
    });
  }

  private resolveQuote(from: CurrencyCode, to: CurrencyCode, amount: bigint): ResolvedQuote {
    try {
      return { ok: true, quote: this.conversion.quoteForExecution(from, to, amount) };
    } catch (error) {
      return { ok: false, error };
    }
  }

  private async work(tx: Db, plan: TransferPlan, key: string): Promise<WorkResult> {
    const { senderId, receiverId, source, destination, amount } = plan;

    // Existence first, whatever the quote says: a missing party is a 404 and never stores a key.
    const found = await tx
      .select({ id: wallets.id })
      .from(wallets)
      .where(inArray(wallets.id, [senderId, receiverId]));
    const ids = new Set(found.map((row) => row.id));
    if (!ids.has(senderId)) throw new AppError('WALLET_NOT_FOUND');
    if (!ids.has(receiverId)) throw new AppError('RECIPIENT_NOT_FOUND');

    // A quote is consumed after the idempotency claim (a retry of a success must replay, not hit
    // QUOTE_USED). Lock order: the quote row first, then the accounts in ascending id order.
    let quote: ConversionQuote | null;
    if (plan.quoteId) {
      quote = await this.quotes.consume(tx, {
        quoteId: plan.quoteId,
        walletId: senderId,
        from: source,
        to: destination,
        sourceMinor: amount,
      });
    } else {
      if (plan.conversion && !plan.conversion.ok) throw plan.conversion.error;
      quote = plan.conversion?.ok ? plan.conversion.quote : null;
    }
    const destAmount = quote ? quote.destMinor : amount;

    const [senderAccount] = await this.ledger.getUserAccounts(senderId, [source], tx);
    const [receiverAccount] = await this.ledger.getUserAccounts(receiverId, [destination], tx);
    if (!senderAccount || !receiverAccount) {
      throw new AppError('INTERNAL_ERROR', { detail: 'Wallet account is missing' });
    }

    // The ledger sorts the user accounts and locks them in ascending id order, so the order of
    // the legs here (and who is the sender) cannot cause a lock-order deadlock.
    const legs = quote
      ? [
          { accountId: senderAccount.id, amount: -amount },
          {
            accountId: await this.ledger.getSystemAccountId('fx_pool', source, tx),
            amount,
          },
          {
            accountId: await this.ledger.getSystemAccountId('fx_pool', destination, tx),
            amount: -destAmount,
          },
          { accountId: receiverAccount.id, amount: destAmount },
        ]
      : [
          { accountId: senderAccount.id, amount: -amount },
          { accountId: receiverAccount.id, amount },
        ];

    const posted = await this.ledger.post(tx, {
      transaction: {
        type: 'transfer',
        initiatorWalletId: senderId,
        counterpartyWalletId: receiverId,
        sourceCurrency: source,
        sourceAmount: amount,
        destCurrency: destination,
        destAmount,
        ...(quote
          ? {
              rate: quote.rate,
              rateSource: quote.rateSource,
              rateAsOf: quote.rateAsOf,
              ...(quote.quoteId ? { quoteId: quote.quoteId } : {}),
            }
          : {}),
        idempotencyKey: key,
      },
      legs,
      activity: [
        {
          walletId: senderId,
          activityType: 'transfer_out',
          currencyOut: source,
          amountOut: amount,
          counterpartyWalletId: receiverId,
        },
        {
          walletId: receiverId,
          activityType: 'transfer_in',
          currencyIn: destination,
          amountIn: destAmount,
          counterpartyWalletId: senderId,
        },
      ],
    });

    // balances_after is the sender's.
    const balancesAfter = await this.ledger.getUserAccounts(senderId, [...CURRENCY_CODES], tx);
    return {
      statusCode: 201,
      body: toPaymentResource(
        posted,
        {
          type: 'transfer',
          parties: { senderWalletId: senderId, receiverWalletId: receiverId },
          source: { currency: source, amount },
          dest: { currency: destination, amount: destAmount },
          ...(quote
            ? {
                conversion: {
                  rate: quote.rate,
                  rateSource: quote.rateSource,
                  rateAsOf: quote.rateAsOf,
                  ...(quote.quoteId ? { quoteId: quote.quoteId } : {}),
                },
              }
            : {}),
        },
        balancesAfter,
      ),
      transactionId: posted.transactionId,
    };
  }
}

import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
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
import type { CreateSwapDto } from './dto/create-swap.dto';

type ResolvedQuote = { ok: true; quote: ConversionQuote } | { ok: false; error: unknown };
type Pricing =
  ResolvedQuote | { quoteId: string; from: CurrencyCode; to: CurrencyCode; amount: bigint };

/** Converts one coin to another inside a single wallet, at the current rate. */
@Injectable()
export class SwapsService {
  constructor(
    private readonly idempotency: IdempotencyService,
    private readonly ledger: LedgerService,
    private readonly conversion: ConversionService,
    private readonly quotes: QuotesService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  swap(
    walletId: string,
    dto: CreateSwapDto,
    key: string,
    requestId: string,
  ): Promise<ExecuteResult> {
    // Validation first, outside the idempotency boundary: validation errors are never stored.
    const from = parseCurrency(dto.from_currency);
    const to = parseCurrency(dto.to_currency);
    if (from === to) {
      throw new AppError('SAME_CURRENCY_SWAP', {
        detail: 'from_currency and to_currency must differ',
      });
    }
    const amount = parseAmount(dto.amount, this.config.MAX_TX_AMOUNT);

    const scope = `wallet:${walletId}:POST /v1/wallets/:id/swaps`;
    const quoteId = dto.quote_id?.toLowerCase();
    const requestHash = hashRequest(scope, {
      from_currency: from,
      to_currency: to,
      amount: formatAmount(amount),
      // Only when present, so the hash of a swap without a quote is unchanged.
      ...(quoteId ? { quote_id: quoteId } : {}),
    });

    // The rate is resolved here, before any database transaction is opened. Its failure is not
    // thrown yet: `work` rethrows it inside the idempotency boundary, so a rejection such as
    // AMOUNT_TOO_SMALL is stored against the key, an FX outage (503) releases the key, and the
    // replay of an earlier success never needs FX at all.
    // With a quote_id the rate was locked earlier: nothing is priced here, and `work` consumes the
    // quote instead.
    const resolved: Pricing = quoteId
      ? { quoteId, from, to, amount }
      : this.resolveQuote(from, to, amount);

    return this.idempotency.execute(
      scope,
      key,
      requestHash,
      (tx) => this.work(tx, walletId, resolved, key),
      { requestId },
    );
  }

  private resolveQuote(from: CurrencyCode, to: CurrencyCode, amount: bigint): ResolvedQuote {
    try {
      return { ok: true, quote: this.conversion.quoteForExecution(from, to, amount) };
    } catch (error) {
      return { ok: false, error };
    }
  }

  private async work(
    tx: Db,
    walletId: string,
    resolved: Pricing,
    key: string,
  ): Promise<WorkResult> {
    // An unknown wallet is a 404 whatever the quote says, and never stores a key.
    const [wallet] = await tx
      .select({ id: wallets.id })
      .from(wallets)
      .where(eq(wallets.id, walletId));
    if (!wallet) throw new AppError('WALLET_NOT_FOUND');

    // Only now surface a quote failure: a 422 (dust) is stored, a 503 (FX outage) releases the key.
    //
    // A quote is consumed here, inside the idempotency work, so after the key was claimed. The
    // order matters: a client retrying a swap that already succeeded reaches the replay branch
    // (the stored 201) before this code runs, and so never sees QUOTE_USED for its own success.
    // Lock order: the quote row first, then the accounts in ascending id order (ledger.post).
    let quote: ConversionQuote;
    if ('quoteId' in resolved) {
      quote = await this.quotes.consume(tx, {
        quoteId: resolved.quoteId,
        walletId,
        from: resolved.from,
        to: resolved.to,
        sourceMinor: resolved.amount,
      });
    } else {
      if (!resolved.ok) throw resolved.error;
      quote = resolved.quote;
    }

    const accounts = await this.ledger.getUserAccounts(walletId, [quote.from, quote.to], tx);
    const fromAccount = accounts.find((account) => account.currency === quote.from);
    const toAccount = accounts.find((account) => account.currency === quote.to);
    if (!fromAccount || !toAccount) {
      throw new AppError('INTERNAL_ERROR', { detail: 'Wallet account is missing' });
    }
    const poolFrom = await this.ledger.getSystemAccountId('fx_pool', quote.from, tx);
    const poolTo = await this.ledger.getSystemAccountId('fx_pool', quote.to, tx);

    const posted = await this.ledger.post(tx, {
      transaction: {
        type: 'swap',
        initiatorWalletId: walletId,
        sourceCurrency: quote.from,
        sourceAmount: quote.sourceMinor,
        destCurrency: quote.to,
        destAmount: quote.destMinor,
        rate: quote.rate,
        rateSource: quote.rateSource,
        rateAsOf: quote.rateAsOf,
        ...(quote.quoteId ? { quoteId: quote.quoteId } : {}),
        idempotencyKey: key,
      },
      legs: [
        { accountId: fromAccount.id, amount: -quote.sourceMinor },
        { accountId: poolFrom, amount: quote.sourceMinor },
        { accountId: poolTo, amount: -quote.destMinor },
        { accountId: toAccount.id, amount: quote.destMinor },
      ],
      activity: [
        {
          walletId,
          activityType: 'swap',
          currencyOut: quote.from,
          amountOut: quote.sourceMinor,
          currencyIn: quote.to,
          amountIn: quote.destMinor,
        },
      ],
    });

    const balancesAfter = await this.ledger.getUserAccounts(walletId, [...CURRENCY_CODES], tx);
    return {
      statusCode: 201,
      body: toPaymentResource(
        posted,
        {
          type: 'swap',
          source: { currency: quote.from, amount: quote.sourceMinor },
          dest: { currency: quote.to, amount: quote.destMinor },
          conversion: {
            rate: quote.rate,
            rateSource: quote.rateSource,
            rateAsOf: quote.rateAsOf,
            ...(quote.quoteId ? { quoteId: quote.quoteId } : {}),
          },
        },
        balancesAfter,
      ),
      transactionId: posted.transactionId,
    };
  }
}

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
import type { CreateDepositDto } from './dto/create-deposit.dto';
import { toDepositResource } from './deposit.mapper';

/** Deposits never touch FX: no rate lookup, same currency in and out. */
@Injectable()
export class DepositsService {
  constructor(
    private readonly idempotency: IdempotencyService,
    private readonly ledger: LedgerService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  deposit(
    walletId: string,
    dto: CreateDepositDto,
    key: string,
    requestId: string,
  ): Promise<ExecuteResult> {
    // Validation first, outside the idempotency boundary: validation errors are never stored.
    const currency = parseCurrency(dto.currency);
    const amount = parseAmount(dto.amount, this.config.MAX_TX_AMOUNT);

    const scope = `wallet:${walletId}:POST /v1/wallets/:id/deposits`;
    const requestHash = hashRequest(scope, { currency, amount: formatAmount(amount) });
    return this.idempotency.execute(
      scope,
      key,
      requestHash,
      (tx) => this.work(tx, walletId, currency, amount, key),
      { requestId },
    );
  }

  private async work(
    tx: Db,
    walletId: string,
    currency: CurrencyCode,
    amount: bigint,
    key: string,
  ): Promise<WorkResult> {
    const [wallet] = await tx
      .select({ id: wallets.id })
      .from(wallets)
      .where(eq(wallets.id, walletId));
    if (!wallet) throw new AppError('WALLET_NOT_FOUND');

    const [account] = await this.ledger.getUserAccounts(walletId, [currency], tx);
    if (!account) throw new AppError('INTERNAL_ERROR', { detail: 'Wallet account is missing' });
    const external = await this.ledger.getSystemAccountId('external', currency, tx);

    const posted = await this.ledger.post(tx, {
      transaction: {
        type: 'deposit',
        initiatorWalletId: walletId,
        sourceCurrency: currency,
        sourceAmount: amount,
        destCurrency: currency,
        destAmount: amount,
        idempotencyKey: key,
      },
      legs: [
        { accountId: external, amount: -amount },
        { accountId: account.id, amount },
      ],
      activity: [{ walletId, activityType: 'deposit', currencyIn: currency, amountIn: amount }],
    });

    const balancesAfter = await this.ledger.getUserAccounts(walletId, [...CURRENCY_CODES], tx);
    return {
      statusCode: 201,
      body: toDepositResource(posted, currency, amount, balancesAfter),
      transactionId: posted.transactionId,
    };
  }
}

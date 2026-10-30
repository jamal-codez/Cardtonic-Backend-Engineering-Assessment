import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DRIZZLE } from '../common/db/database.module';
import { accounts, ledgerEntries, transactions } from '../common/db/schema';
import type { Db } from '../common/db/with-transaction';
import { AppError } from '../common/errors/app-error';
import { toTransactionDetail, type TransactionDetail } from './transaction.mapper';

@Injectable()
export class TransactionDetailService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async get(id: string): Promise<TransactionDetail> {
    const [tx] = await this.db.select().from(transactions).where(eq(transactions.id, id));
    if (!tx) throw new AppError('TRANSACTION_NOT_FOUND');

    const entries = await this.db
      .select({
        kind: accounts.kind,
        walletId: accounts.walletId,
        currency: ledgerEntries.currency,
        amount: ledgerEntries.amount,
      })
      .from(ledgerEntries)
      .innerJoin(accounts, eq(accounts.id, ledgerEntries.accountId))
      .where(eq(ledgerEntries.transactionId, id))
      .orderBy(ledgerEntries.id);

    return toTransactionDetail(tx, entries);
  }
}

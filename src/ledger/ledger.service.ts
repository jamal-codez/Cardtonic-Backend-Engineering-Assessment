import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { DRIZZLE } from '../common/db/database.module';
import { CURRENCY_CODES } from '../common/money/currency';
import {
  accounts,
  ledgerEntries,
  transactions,
  wallets,
  walletActivity,
} from '../common/db/schema';
import type { Db } from '../common/db/with-transaction';
import { AppError } from '../common/errors/app-error';
import type { Leg, PostInput, PostResult, SystemAccountKind, UserAccount } from './ledger.types';

interface LegAccount {
  id: string;
  kind: string;
  currency: string;
  walletId: string | null;
}

/**
 * The only writer of balances, transactions, ledger entries and wallet activity.
 * `post` runs inside a transaction opened by the caller (see withTransaction).
 */
@Injectable()
export class LedgerService {
  private readonly systemAccountIds = new Map<string, string>();

  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  /** Opens one zero-balance user account per supported currency. Only the ledger writes accounts. */
  async openUserAccounts(tx: Db, walletId: string): Promise<void> {
    await tx.insert(accounts).values(
      CURRENCY_CODES.map((currency) => ({
        id: uuidv7(),
        walletId,
        currency,
        kind: 'user',
        balance: 0n,
      })),
    );
  }

  /** Unlocked read. Never use it for an overdraft check; `post` re-reads under `FOR UPDATE`. */
  async getUserAccounts(
    walletId: string,
    currencyCodes: string[],
    executor: Db = this.db,
  ): Promise<UserAccount[]> {
    const rows = await executor
      .select({ id: accounts.id, currency: accounts.currency, balance: accounts.balance })
      .from(accounts)
      .where(
        and(
          eq(accounts.walletId, walletId),
          eq(accounts.kind, 'user'),
          inArray(accounts.currency, currencyCodes),
        ),
      );
    return rows.map((row) => ({ ...row, balance: row.balance ?? 0n }));
  }

  /** System accounts never change after seeding, so the id is cached after the first load. */
  async getSystemAccountId(
    kind: SystemAccountKind,
    currency: string,
    executor: Db = this.db,
  ): Promise<string> {
    const cacheKey = `${kind}:${currency}`;
    const cached = this.systemAccountIds.get(cacheKey);
    if (cached) return cached;

    const [row] = await executor
      .select({ id: accounts.id })
      .from(accounts)
      .where(and(eq(accounts.kind, kind), eq(accounts.currency, currency)));
    if (!row) {
      throw new AppError('INTERNAL_ERROR', {
        detail: `System account ${cacheKey} is missing; has the database been seeded?`,
      });
    }
    this.systemAccountIds.set(cacheKey, row.id);
    return row.id;
  }

  /** Needed after the test helper reseeds, which creates new system account ids. */
  clearSystemAccountCache(): void {
    this.systemAccountIds.clear();
  }

  async post(tx: Db, input: PostInput): Promise<PostResult> {
    const deltas = this.netDeltas(input.legs);

    // 1. Programming-error checks first, before any lock is taken. kind, currency and wallet_id
    // never change after insert, so an unlocked read is safe.
    const legAccounts = await this.loadLegAccounts(tx, [...deltas.keys()]);
    this.assertBalancedPerCurrency(input.legs, legAccounts);
    this.assertHeaderMatchesLegs(input, legAccounts);

    // 2. Lock user accounts only, in ascending id order, every time. System accounts are never
    // locked: their balance is the sum of their entries.
    const userIds = [...legAccounts.values()]
      .filter((account) => account.kind === 'user')
      .map((account) => account.id)
      .sort();
    const locked = new Map<string, { walletId: string | null; balance: bigint }>();
    if (userIds.length > 0) {
      const rows = await tx
        .select({ id: accounts.id, walletId: accounts.walletId, balance: accounts.balance })
        .from(accounts)
        .where(inArray(accounts.id, userIds))
        .orderBy(accounts.id)
        .for('update');
      for (const row of rows) {
        locked.set(row.id, { walletId: row.walletId, balance: row.balance ?? 0n });
      }
    }

    // 3. Overdraft check on the locked balances.
    const debitedWalletIds = new Set<string>();
    for (const userId of userIds) {
      const delta = deltas.get(userId) ?? 0n;
      const account = locked.get(userId);
      if (!account) throw new AppError('INTERNAL_ERROR', { detail: 'Locked account not found' });
      if (delta < 0n) {
        if (account.balance + delta < 0n) throw new AppError('INSUFFICIENT_FUNDS');
        if (account.walletId) debitedWalletIds.add(account.walletId);
      }
    }

    // 4. Debited wallets must be active. Credits to a frozen wallet are allowed.
    if (debitedWalletIds.size > 0) {
      const rows = await tx
        .select({ id: wallets.id, status: wallets.status })
        .from(wallets)
        .where(inArray(wallets.id, [...debitedWalletIds]));
      if (rows.some((row) => row.status !== 'active')) throw new AppError('WALLET_FROZEN');
    }

    // 5. Transaction, entries and activity. Stored timestamps come from the database.
    const transactionId = uuidv7();
    const [inserted] = await tx
      .insert(transactions)
      .values({ ...input.transaction, id: transactionId })
      .returning({ createdAt: transactions.createdAt });
    if (!inserted) throw new AppError('INTERNAL_ERROR', { detail: 'Transaction insert failed' });

    await tx.insert(ledgerEntries).values(
      input.legs.map((leg) => ({
        transactionId,
        accountId: leg.accountId,
        currency: legAccounts.get(leg.accountId)?.currency ?? '',
        amount: leg.amount,
      })),
    );

    if (input.activity.length > 0) {
      await tx.insert(walletActivity).values(
        input.activity.map((row) => ({
          id: uuidv7(),
          walletId: row.walletId,
          transactionId,
          activityType: row.activityType,
          currencyOut: row.currencyOut ?? null,
          amountOut: row.amountOut ?? null,
          currencyIn: row.currencyIn ?? null,
          amountIn: row.amountIn ?? null,
          counterpartyWalletId: row.counterpartyWalletId ?? null,
          // now() is fixed for the whole database transaction, so this equals transactions.created_at
          // exactly. Passing the returned JS Date back would truncate it to milliseconds.
          createdAt: sql`now()`,
        })),
      );
    }

    // 6. Update stored balances for user accounts only, in the same ascending order.
    const balances = new Map<string, bigint>();
    for (const userId of userIds) {
      const delta = deltas.get(userId) ?? 0n;
      const [updated] = await tx
        .update(accounts)
        .set({
          balance: sql`${accounts.balance} + ${delta.toString()}::bigint`,
          updatedAt: sql`now()`,
        })
        .where(eq(accounts.id, userId))
        .returning({ balance: accounts.balance });
      if (updated?.balance == null) {
        throw new AppError('INTERNAL_ERROR', { detail: 'Balance update failed' });
      }
      balances.set(userId, updated.balance);
    }

    return { transactionId, createdAt: inserted.createdAt, balances };
  }

  /** Net signed amount per account; rejects empty, one-legged and zero-amount postings. */
  private netDeltas(legs: Leg[]): Map<string, bigint> {
    if (legs.length < 2) {
      throw new AppError('INTERNAL_ERROR', { detail: 'A posting needs at least two legs' });
    }
    const deltas = new Map<string, bigint>();
    for (const leg of legs) {
      if (leg.amount === 0n) {
        throw new AppError('INTERNAL_ERROR', { detail: 'A leg amount must not be zero' });
      }
      deltas.set(leg.accountId, (deltas.get(leg.accountId) ?? 0n) + leg.amount);
    }
    return deltas;
  }

  private async loadLegAccounts(tx: Db, ids: string[]): Promise<Map<string, LegAccount>> {
    const rows = await tx
      .select({
        id: accounts.id,
        kind: accounts.kind,
        currency: accounts.currency,
        walletId: accounts.walletId,
      })
      .from(accounts)
      .where(inArray(accounts.id, ids));
    if (rows.length !== ids.length) {
      throw new AppError('INTERNAL_ERROR', {
        detail: 'A posting leg references an unknown account',
      });
    }
    return new Map(rows.map((row) => [row.id, row]));
  }

  /** The transaction row must describe currencies that the legs actually move. */
  private assertHeaderMatchesLegs(input: PostInput, legAccounts: Map<string, LegAccount>): void {
    const legCurrencies = new Set([...legAccounts.values()].map((account) => account.currency));
    const { sourceCurrency, destCurrency } = input.transaction;
    if (!legCurrencies.has(sourceCurrency) || !legCurrencies.has(destCurrency)) {
      throw new AppError('INTERNAL_ERROR', {
        detail: 'Transaction currencies do not match the posting legs',
      });
    }
  }

  private assertBalancedPerCurrency(legs: Leg[], legAccounts: Map<string, LegAccount>): void {
    const sums = new Map<string, bigint>();
    for (const leg of legs) {
      const currency = legAccounts.get(leg.accountId)?.currency;
      if (!currency) throw new AppError('INTERNAL_ERROR', { detail: 'Unknown leg account' });
      sums.set(currency, (sums.get(currency) ?? 0n) + leg.amount);
    }
    for (const [currency, sum] of sums) {
      if (sum !== 0n) {
        throw new AppError('INTERNAL_ERROR', {
          detail: `Posting does not balance in ${currency}`,
        });
      }
    }
  }
}

import type { transactions } from '../common/db/schema';

export type SystemAccountKind = 'external' | 'fx_pool';

export type ActivityType = 'deposit' | 'swap' | 'transfer_in' | 'transfer_out';

/** Transaction row data minus the fields the posting engine assigns (id, created_at). */
export type NewTransaction = Omit<typeof transactions.$inferInsert, 'id' | 'createdAt'>;

/** One signed movement on one account: positive credits it, negative debits it. */
export interface Leg {
  accountId: string;
  amount: bigint;
}

export interface ActivityInput {
  walletId: string;
  activityType: ActivityType;
  currencyOut?: string;
  amountOut?: bigint;
  currencyIn?: string;
  amountIn?: bigint;
  counterpartyWalletId?: string;
}

export interface PostInput {
  transaction: NewTransaction;
  legs: Leg[];
  activity: ActivityInput[];
}

export interface PostResult {
  transactionId: string;
  createdAt: Date;
  /** New balance of every user account touched by the posting, keyed by account id. */
  balances: Map<string, bigint>;
}

export interface UserAccount {
  id: string;
  currency: string;
  balance: bigint;
}

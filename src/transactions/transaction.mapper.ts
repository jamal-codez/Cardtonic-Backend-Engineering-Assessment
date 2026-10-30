import { formatAmount } from '../common/money/money';

export interface HistoryRow {
  id: string;
  transaction_id: string;
  activity_type: string;
  currency_out: string | null;
  amount_out: string | null;
  currency_in: string | null;
  amount_in: string | null;
  counterparty_wallet_id: string | null;
  /**
   * created_at printed by Postgres in UTC with microseconds. Drizzle's raw queries return
   * timestamps as strings, and the cursor needs the full precision anyway.
   */
  created_at_us: string;
  rate: string | null;
  rate_source: string | null;
}

export interface HistoryItem {
  transaction_id: string;
  type: string;
  currency_out: string | null;
  amount_out: string | null;
  currency_in: string | null;
  amount_in: string | null;
  counterparty_wallet_id: string | null;
  rate: string | null;
  rate_source: string | null;
  created_at: string;
}

const amount = (value: string | null): string | null =>
  value === null ? null : formatAmount(BigInt(value));

export function toHistoryItem(row: HistoryRow): HistoryItem {
  return {
    transaction_id: row.transaction_id,
    type: row.activity_type,
    currency_out: row.currency_out,
    amount_out: amount(row.amount_out),
    currency_in: row.currency_in,
    amount_in: amount(row.amount_in),
    counterparty_wallet_id: row.counterparty_wallet_id,
    rate: row.rate,
    rate_source: row.rate_source,
    // Millisecond ISO like every other endpoint (the first 23 characters, then Z).
    created_at: `${row.created_at_us.slice(0, 23)}Z`,
  };
}

export interface TransactionRow {
  id: string;
  type: string;
  status: string;
  initiatorWalletId: string;
  counterpartyWalletId: string | null;
  sourceCurrency: string;
  sourceAmount: bigint;
  destCurrency: string;
  destAmount: bigint;
  rate: string | null;
  rateSource: string | null;
  rateAsOf: Date | null;
  createdAt: Date;
}

export interface EntryRow {
  kind: string;
  walletId: string | null;
  currency: string;
  amount: bigint;
}

export interface TransactionDetail {
  id: string;
  type: string;
  status: string;
  initiator_wallet_id: string;
  counterparty_wallet_id: string | null;
  source_currency: string;
  source_amount: string;
  dest_currency: string;
  dest_amount: string;
  rate: string | null;
  rate_source: string | null;
  rate_as_of: string | null;
  created_at: string;
  entries: { account_kind: string; wallet_id: string | null; currency: string; amount: string }[];
}

export function toTransactionDetail(tx: TransactionRow, entries: EntryRow[]): TransactionDetail {
  return {
    id: tx.id,
    type: tx.type,
    status: tx.status,
    initiator_wallet_id: tx.initiatorWalletId,
    counterparty_wallet_id: tx.counterpartyWalletId,
    source_currency: tx.sourceCurrency,
    source_amount: formatAmount(tx.sourceAmount),
    dest_currency: tx.destCurrency,
    dest_amount: formatAmount(tx.destAmount),
    rate: tx.rate,
    rate_source: tx.rateSource,
    rate_as_of: tx.rateAsOf ? tx.rateAsOf.toISOString() : null,
    created_at: tx.createdAt.toISOString(),
    entries: entries.map((entry) => ({
      account_kind: entry.kind,
      wallet_id: entry.walletId,
      currency: entry.currency,
      amount: formatAmount(entry.amount),
    })),
  };
}

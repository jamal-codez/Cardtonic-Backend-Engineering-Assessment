export type ReconMode = 'incremental' | 'full';

export interface DriftItem {
  account_id: string;
  wallet_id: string | null;
  currency: string;
  /** The stored accounts.balance, 6 decimals. */
  stored: string;
  /** The sum of the account's entries, 6 decimals. */
  expected: string;
  /** stored - expected, signed, 6 decimals. */
  delta: string;
}

export interface UnbalancedTransaction {
  transaction_id: string;
  entries: number;
}

export interface ReconciliationRun {
  id: string;
  mode: ReconMode;
  startedAt: Date;
  finishedAt: Date;
  /** Lower bound of the scope; null when the whole ledger was checked. */
  windowFrom: Date | null;
  accountsChecked: number;
  drift: DriftItem[];
  /**
   * Net of the entries in scope per currency (every supported currency is present). For an
   * incremental run that is the net of the transactions inside the window, not a global net.
   */
  currencyNet: Record<string, string>;
  unbalancedTx: UnbalancedTransaction[];
  ok: boolean;
}

export interface SkippedRun {
  skipped: true;
}

export type ReconcileResult = ReconciliationRun | SkippedRun;

export function isSkipped(result: ReconcileResult): result is SkippedRun {
  return 'skipped' in result;
}

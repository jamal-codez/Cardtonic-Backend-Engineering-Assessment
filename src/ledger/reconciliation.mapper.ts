import type { ReconciliationRun } from './reconciliation.types';

export interface ReconciliationRunResource {
  id: string;
  mode: string;
  started_at: string;
  finished_at: string;
  window_from: string | null;
  accounts_checked: number;
  ok: boolean;
  drift: ReconciliationRun['drift'];
  currency_net: ReconciliationRun['currencyNet'];
  unbalanced_transactions: ReconciliationRun['unbalancedTx'];
}

export function toRunResource(run: ReconciliationRun): ReconciliationRunResource {
  return {
    id: run.id,
    mode: run.mode,
    started_at: run.startedAt.toISOString(),
    finished_at: run.finishedAt.toISOString(),
    window_from: run.windowFrom ? run.windowFrom.toISOString() : null,
    accounts_checked: run.accountsChecked,
    ok: run.ok,
    drift: run.drift,
    currency_net: run.currencyNet,
    unbalanced_transactions: run.unbalancedTx,
  };
}

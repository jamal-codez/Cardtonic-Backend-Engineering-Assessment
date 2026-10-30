import { formatAmount } from '../../common/money/money';
import type { PostResult, UserAccount } from '../../ledger/ledger.types';
import { toBalanceResources, type BalanceResource } from '../../wallets/wallet.mapper';

export interface DepositResource {
  transaction: {
    id: string;
    type: 'deposit';
    source_currency: string;
    source_amount: string;
    dest_currency: string;
    dest_amount: string;
    created_at: string;
  };
  balances_after: BalanceResource[];
}

export function toDepositResource(
  posted: PostResult,
  currency: string,
  amount: bigint,
  balancesAfter: UserAccount[],
): DepositResource {
  return {
    transaction: {
      id: posted.transactionId,
      type: 'deposit',
      source_currency: currency,
      source_amount: formatAmount(amount),
      dest_currency: currency,
      dest_amount: formatAmount(amount),
      created_at: posted.createdAt.toISOString(),
    },
    balances_after: toBalanceResources(balancesAfter),
  };
}

/** Location of the created transaction, derived from the (stored) response body. */
export function depositLocation(statusCode: number, body: unknown): string | undefined {
  if (statusCode !== 201) return undefined;
  const id = (body as Partial<DepositResource> | null)?.transaction?.id;
  return id ? `/v1/transactions/${id}` : undefined;
}

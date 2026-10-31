import { formatAmount } from '../common/money/money';
import type { PostResult, UserAccount } from '../ledger/ledger.types';
import { toBalanceResources, type BalanceResource } from '../wallets/wallet.mapper';

export interface PaymentResource {
  transaction: {
    id: string;
    type: 'deposit' | 'swap' | 'transfer';
    /** Present only for transfers. */
    sender_wallet_id?: string;
    receiver_wallet_id?: string;
    source_currency: string;
    source_amount: string;
    dest_currency: string;
    dest_amount: string;
    /** Present only when the transaction converted between currencies. */
    rate?: string;
    rate_source?: string;
    rate_as_of?: string;
    /** Present only when the conversion executed a quote. */
    quote_id?: string;
    created_at: string;
  };
  balances_after: BalanceResource[];
}

export interface PaymentDetails {
  type: 'deposit' | 'swap' | 'transfer';
  /** Set for transfers: who sent and who received. */
  parties?: { senderWalletId: string; receiverWalletId: string };
  source: { currency: string; amount: bigint };
  dest: { currency: string; amount: bigint };
  conversion?: { rate: string; rateSource: string; rateAsOf: Date; quoteId?: string };
}

/** Response body shared by deposits and swaps; swaps add the recorded rate and its provenance. */
export function toPaymentResource(
  posted: PostResult,
  details: PaymentDetails,
  balancesAfter: UserAccount[],
): PaymentResource {
  return {
    transaction: {
      id: posted.transactionId,
      type: details.type,
      ...(details.parties
        ? {
            sender_wallet_id: details.parties.senderWalletId,
            receiver_wallet_id: details.parties.receiverWalletId,
          }
        : {}),
      source_currency: details.source.currency,
      source_amount: formatAmount(details.source.amount),
      dest_currency: details.dest.currency,
      dest_amount: formatAmount(details.dest.amount),
      ...(details.conversion
        ? {
            rate: details.conversion.rate,
            rate_source: details.conversion.rateSource,
            rate_as_of: details.conversion.rateAsOf.toISOString(),
            ...(details.conversion.quoteId ? { quote_id: details.conversion.quoteId } : {}),
          }
        : {}),
      created_at: posted.createdAt.toISOString(),
    },
    balances_after: toBalanceResources(balancesAfter),
  };
}

/** Location of the created transaction, derived from the (stored) response body. */
export function paymentLocation(statusCode: number, body: unknown): string | undefined {
  if (statusCode !== 201) return undefined;
  const id = (body as Partial<PaymentResource> | null)?.transaction?.id;
  return id ? `/v1/transactions/${id}` : undefined;
}

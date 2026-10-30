import type { wallets } from '../common/db/schema';
import { CURRENCY_CODES } from '../common/money/currency';
import { formatAmount } from '../common/money/money';
import type { UserAccount } from '../ledger/ledger.types';

export type WalletRow = typeof wallets.$inferSelect;

export interface BalanceResource {
  currency: string;
  amount: string;
}

export interface WalletResource {
  id: string;
  email: string | null;
  phone: string | null;
  status: string;
  created_at: string;
  balances: BalanceResource[];
}

/** Always all supported coins in registry order, zero when the account is missing. */
export function toBalanceResources(accounts: UserAccount[]): BalanceResource[] {
  return CURRENCY_CODES.map((currency) => {
    const account = accounts.find((candidate) => candidate.currency === currency);
    return { currency, amount: formatAmount(account?.balance ?? 0n) };
  });
}

export function toWalletResource(wallet: WalletRow, accounts: UserAccount[]): WalletResource {
  return {
    id: wallet.id,
    email: wallet.email,
    phone: wallet.phone,
    status: wallet.status,
    created_at: wallet.createdAt.toISOString(),
    balances: toBalanceResources(accounts),
  };
}

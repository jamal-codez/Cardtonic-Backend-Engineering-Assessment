import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { DRIZZLE, TransactionRunner } from '../common/db/database.module';
import { wallets } from '../common/db/schema';
import type { Db } from '../common/db/with-transaction';
import { AppError } from '../common/errors/app-error';
import { mapPgError } from '../common/errors/pg-error-mapper';
import { CURRENCY_CODES } from '../common/money/currency';
import { RateService } from '../fx/rate.service';
import { LedgerService } from '../ledger/ledger.service';
import { normalizeEmail, normalizePhone } from './identity';
import { toWalletResource, type WalletResource } from './wallet.mapper';

export interface CreateWalletInput {
  email?: string;
  phone?: string;
}

@Injectable()
export class WalletsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly transactions: TransactionRunner,
    private readonly ledger: LedgerService,
    private readonly rates: RateService,
  ) {}

  /**
   * Creates a wallet and its zero-balance accounts in one transaction. No idempotency key is
   * needed: the unique constraints on email and phone make a repeated request fail with 409
   * instead of creating a second wallet.
   */
  async create(input: CreateWalletInput): Promise<WalletResource> {
    if (input.email === undefined && input.phone === undefined) {
      throw new AppError('VALIDATION_ERROR', {
        detail: 'Provide an email, a phone number, or both',
        errors: [{ field: 'email', message: 'email or phone is required' }],
      });
    }
    const email = input.email === undefined ? null : normalizeEmail(input.email);
    const phone = input.phone === undefined ? null : normalizePhone(input.phone);

    try {
      return await this.transactions.run(async (tx) => {
        const [wallet] = await tx
          .insert(wallets)
          .values({ id: uuidv7(), email, phone })
          .returning();
        if (!wallet) throw new AppError('INTERNAL_ERROR', { detail: 'Wallet insert failed' });
        await this.ledger.openUserAccounts(tx, wallet.id);
        const accounts = await this.ledger.getUserAccounts(wallet.id, [...CURRENCY_CODES], tx);
        return toWalletResource(wallet, accounts, this.rates.usdValue(accounts));
      });
    } catch (error) {
      // The detail stays generic on purpose: never reveal which identifier clashed or who owns it.
      const mapped = mapPgError(error, { uniqueViolation: 'WALLET_ALREADY_EXISTS' });
      throw mapped instanceof Error ? mapped : error;
    }
  }

  async get(id: string): Promise<WalletResource> {
    const [wallet] = await this.db.select().from(wallets).where(eq(wallets.id, id));
    if (!wallet) throw new AppError('WALLET_NOT_FOUND');
    const accounts = await this.ledger.getUserAccounts(id, [...CURRENCY_CODES]);
    return toWalletResource(wallet, accounts, this.rates.usdValue(accounts));
  }
}

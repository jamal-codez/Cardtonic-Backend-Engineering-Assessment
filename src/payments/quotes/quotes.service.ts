import { Inject, Injectable } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { CLOCK, type Clock } from '../../common/clock/clock';
import { APP_CONFIG, type AppConfig } from '../../common/config/config';
import { DRIZZLE } from '../../common/db/database.module';
import { fxQuotes, wallets } from '../../common/db/schema';
import type { Db } from '../../common/db/with-transaction';
import { AppError } from '../../common/errors/app-error';
import { parseCurrency, type CurrencyCode } from '../../common/money/currency';
import { parseAmount } from '../../common/money/money';
import { ConversionService, type ConversionQuote } from '../conversion/conversion.service';
import type { CreateQuoteDto } from './dto/create-quote.dto';

export interface CreatedQuote {
  id: string;
  rate: string;
  sourceMinor: bigint;
  destMinor: bigint;
  source: 'live' | 'static';
  expiresAt: Date;
}

export interface QuoteUse {
  quoteId: string;
  walletId: string;
  from: CurrencyCode;
  to: CurrencyCode;
  sourceMinor: bigint;
}

/**
 * Locks a rate for a short time and lets exactly one swap or transfer execute against it.
 *
 * Creating a quote prices from the in-memory snapshot (no network, no transaction). Consuming one
 * happens inside the idempotency work of a swap or transfer.
 */
@Injectable()
export class QuotesService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly conversion: ConversionService,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async create(dto: CreateQuoteDto): Promise<CreatedQuote> {
    const walletId = dto.wallet_id.toLowerCase();
    const from = parseCurrency(dto.from_currency);
    const to = parseCurrency(dto.to_currency);
    if (from === to) {
      throw new AppError('SAME_CURRENCY_SWAP', {
        detail: 'from_currency and to_currency must differ',
      });
    }
    const amount = parseAmount(dto.amount, this.config.MAX_TX_AMOUNT);

    const [wallet] = await this.db
      .select({ id: wallets.id })
      .from(wallets)
      .where(eq(wallets.id, walletId));
    if (!wallet) throw new AppError('WALLET_NOT_FOUND');

    // Dust is a 422 and an FX outage a 503, exactly as for a swap.
    const priced = this.conversion.quoteForExecution(from, to, amount);
    if (priced.rateSource === 'quote') {
      throw new AppError('INTERNAL_ERROR', { detail: 'A quote cannot be priced from a quote' });
    }
    const expiresAt = new Date(this.clock.now().getTime() + this.config.FX_QUOTE_TTL_MS);
    const id = uuidv7();
    await this.db.insert(fxQuotes).values({
      id,
      walletId,
      fromCurrency: from,
      toCurrency: to,
      sourceAmount: priced.sourceMinor,
      destAmount: priced.destMinor,
      rate: priced.rate,
      rateSource: priced.rateSource,
      rateAsOf: priced.rateAsOf,
      expiresAt,
    });
    return {
      id,
      rate: priced.rate,
      sourceMinor: priced.sourceMinor,
      destMinor: priced.destMinor,
      source: priced.rateSource,
      expiresAt,
    };
  }

  /**
   * Marks the quote used and returns the conversion to execute. Call it inside the idempotency
   * work, after the claim and before the ledger post: the quote row is locked first and the
   * accounts after it (ascending id, in LedgerService.post), always in that order.
   *
   * The checks run in a fixed order: unknown, then a quote for something else, then already used,
   * then expired. A 422 here is stored against the idempotency key and rolls back `used_at`, so a
   * failed swap does not burn the quote.
   */
  async consume(tx: Db, use: QuoteUse): Promise<ConversionQuote> {
    const [row] = await tx
      .select()
      .from(fxQuotes)
      .where(eq(fxQuotes.id, use.quoteId))
      .for('update');
    if (!row) throw new AppError('QUOTE_NOT_FOUND');

    if (
      row.walletId !== use.walletId ||
      row.fromCurrency !== use.from ||
      row.toCurrency !== use.to ||
      row.sourceAmount !== use.sourceMinor
    ) {
      throw new AppError('QUOTE_MISMATCH', {
        detail: 'The quote was issued for a different wallet, currency pair or amount',
      });
    }
    if (row.usedAt) throw new AppError('QUOTE_USED');
    if (this.clock.now().getTime() >= row.expiresAt.getTime()) {
      throw new AppError('QUOTE_EXPIRED');
    }

    await tx
      .update(fxQuotes)
      .set({ usedAt: sql`now()` })
      .where(eq(fxQuotes.id, row.id));

    return {
      from: use.from,
      to: use.to,
      sourceMinor: row.sourceAmount,
      destMinor: row.destAmount,
      rate: row.rate,
      rateSource: 'quote',
      rateAsOf: row.rateAsOf,
      quoteId: row.id,
    };
  }
}

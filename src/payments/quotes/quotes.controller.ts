import { Body, Controller, HttpCode, Post, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { ApiProblems, ApiSuccess, ApiSummary } from '../../common/http/api-docs';
import { formatAmount } from '../../common/money/money';
import { QUOTE_EXAMPLE } from '../../docs/examples';
import { CreateQuoteDto } from './dto/create-quote.dto';
import { QuotesService } from './quotes.service';

export interface QuoteResource {
  quote_id: string;
  rate: string;
  source_amount: string;
  destination_amount: string;
  /** Where the locked rate came from (simulated or static). */
  source: string;
  expires_at: string;
}

@ApiTags('fx')
@Controller('fx/quotes')
export class QuotesController {
  constructor(private readonly quotes: QuotesService) {}

  @Post()
  @HttpCode(201)
  @ApiSummary(
    'Lock the current rate for a short time',
    'Pass the returned quote_id to a swap or a cross-currency transfer from the same wallet, for the same pair and amount. A quote works once and expires after FX_QUOTE_TTL_MS (default 30 seconds).',
  )
  @ApiSuccess(201, 'Quote created (Location header set)', QUOTE_EXAMPLE)
  @ApiProblems(
    'VALIDATION_ERROR',
    'UNSUPPORTED_CURRENCY',
    'SAME_CURRENCY_SWAP',
    'WALLET_NOT_FOUND',
    'AMOUNT_TOO_SMALL',
    'AMOUNT_LIMIT_EXCEEDED',
    'FX_UNAVAILABLE',
  )
  async create(
    @Body() dto: CreateQuoteDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<QuoteResource> {
    const quote = await this.quotes.create(dto);
    res.setHeader('Location', `/v1/fx/quotes/${quote.id}`);
    return {
      quote_id: quote.id,
      rate: quote.rate,
      source_amount: formatAmount(quote.sourceMinor),
      destination_amount: formatAmount(quote.destMinor),
      source: quote.source,
      expires_at: quote.expiresAt.toISOString(),
    };
  }
}

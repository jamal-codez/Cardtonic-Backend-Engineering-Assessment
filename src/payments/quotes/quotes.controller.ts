import { Body, Controller, HttpCode, Post, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { formatAmount } from '../../common/money/money';
import { CreateQuoteDto } from './dto/create-quote.dto';
import { QuotesService } from './quotes.service';

export interface QuoteResource {
  quote_id: string;
  rate: string;
  source_amount: string;
  destination_amount: string;
  /** Where the locked rate came from (live or static). */
  source: string;
  expires_at: string;
}

@ApiTags('fx')
@Controller('fx/quotes')
export class QuotesController {
  constructor(private readonly quotes: QuotesService) {}

  /** Locks the current rate for a short time. Execute a swap or transfer with the returned quote_id. */
  @Post()
  @HttpCode(201)
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

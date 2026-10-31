import { Body, Controller, Headers, Param, Post, Req, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { ApiIdempotencyKey, ApiProblems, ApiSuccess, ApiSummary } from '../../common/http/api-docs';
import { UuidParamPipe } from '../../common/http/uuid-param.pipe';
import { SWAP_EXAMPLE } from '../../docs/examples';
import { parseIdempotencyKey } from '../../idempotency/idempotency-key';
import { sendIdempotentResponse } from '../../idempotency/send-idempotent-response';
import { paymentLocation } from '../payment.mapper';
import { CreateSwapDto } from './dto/create-swap.dto';
import { SwapsService } from './swaps.service';

@ApiTags('swaps')
@Controller('wallets/:id/swaps')
export class SwapsController {
  constructor(private readonly swaps: SwapsService) {}

  @Post()
  @ApiIdempotencyKey()
  @ApiSummary(
    'Swap one coin for another inside a wallet',
    'Converts at the current rate (or at the rate of quote_id), flooring the destination to 6 decimals. The rate, its source and its time are recorded on the transaction.',
  )
  @ApiSuccess(201, 'Swap executed (Location points at the transaction)', SWAP_EXAMPLE)
  @ApiProblems(
    'IDEMPOTENCY_KEY_REQUIRED',
    'IDEMPOTENCY_KEY_INVALID',
    'UNSUPPORTED_CURRENCY',
    'SAME_CURRENCY_SWAP',
    'VALIDATION_ERROR',
    'WALLET_NOT_FOUND',
    'QUOTE_NOT_FOUND',
    'INSUFFICIENT_FUNDS',
    'AMOUNT_TOO_SMALL',
    'AMOUNT_LIMIT_EXCEEDED',
    'WALLET_FROZEN',
    'QUOTE_EXPIRED',
    'QUOTE_USED',
    'QUOTE_MISMATCH',
    'IDEMPOTENCY_KEY_REUSED',
    'FX_UNAVAILABLE',
    'RETRY_LATER',
  )
  async create(
    @Param('id', UuidParamPipe) walletId: string,
    @Body() dto: CreateSwapDto,
    @Headers('idempotency-key') keyHeader: unknown,
    @Req() req: Request & { id?: string },
    @Res() res: Response,
  ): Promise<void> {
    const key = parseIdempotencyKey(keyHeader);
    const result = await this.swaps.swap(walletId, dto, key, req.id ?? 'unknown');
    sendIdempotentResponse(res, result, paymentLocation(result.statusCode, result.body));
  }
}

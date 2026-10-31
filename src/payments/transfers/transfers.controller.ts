import { Body, Controller, Headers, Param, Post, Req, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { ApiIdempotencyKey, ApiProblems, ApiSuccess, ApiSummary } from '../../common/http/api-docs';
import { UuidParamPipe } from '../../common/http/uuid-param.pipe';
import { TRANSFER_EXAMPLE } from '../../docs/examples';
import { parseIdempotencyKey } from '../../idempotency/idempotency-key';
import { sendIdempotentResponse } from '../../idempotency/send-idempotent-response';
import { paymentLocation } from '../payment.mapper';
import { CreateTransferDto } from './dto/create-transfer.dto';
import { TransfersService } from './transfers.service';

@ApiTags('transfers')
@Controller('wallets/:id/transfers')
export class TransfersController {
  constructor(private readonly transfers: TransfersService) {}

  @Post()
  @ApiIdempotencyKey()
  @ApiSummary(
    'Send coins to another wallet, converting when the currencies differ',
    'Same-currency transfers never read an FX rate and keep working during an FX outage. Cross-currency transfers convert like a swap. balances_after is the sender.',
  )
  @ApiSuccess(201, 'Transfer executed (Location points at the transaction)', TRANSFER_EXAMPLE)
  @ApiProblems(
    'IDEMPOTENCY_KEY_REQUIRED',
    'IDEMPOTENCY_KEY_INVALID',
    'UNSUPPORTED_CURRENCY',
    'SELF_TRANSFER',
    'VALIDATION_ERROR',
    'WALLET_NOT_FOUND',
    'RECIPIENT_NOT_FOUND',
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
    @Param('id', UuidParamPipe) senderId: string,
    @Body() dto: CreateTransferDto,
    @Headers('idempotency-key') keyHeader: unknown,
    @Req() req: Request & { id?: string },
    @Res() res: Response,
  ): Promise<void> {
    const key = parseIdempotencyKey(keyHeader);
    const result = await this.transfers.transfer(senderId, dto, key, req.id ?? 'unknown');
    sendIdempotentResponse(res, result, paymentLocation(result.statusCode, result.body));
  }
}

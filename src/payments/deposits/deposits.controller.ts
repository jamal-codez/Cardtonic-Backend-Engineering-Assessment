import { Body, Controller, Headers, Param, Post, Req, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { ApiIdempotencyKey, ApiProblems, ApiSuccess, ApiSummary } from '../../common/http/api-docs';
import { UuidParamPipe } from '../../common/http/uuid-param.pipe';
import { DEPOSIT_EXAMPLE } from '../../docs/examples';
import { parseIdempotencyKey } from '../../idempotency/idempotency-key';
import { sendIdempotentResponse } from '../../idempotency/send-idempotent-response';
import { CreateDepositDto } from './dto/create-deposit.dto';
import { paymentLocation } from '../payment.mapper';
import { DepositsService } from './deposits.service';

@ApiTags('deposits')
@Controller('wallets/:id/deposits')
export class DepositsController {
  constructor(private readonly deposits: DepositsService) {}

  @Post()
  @ApiIdempotencyKey()
  @ApiSummary(
    'Simulated deposit',
    'Credits the wallet from the external account. Sandbox only: nothing real moves. Never touches FX.',
  )
  @ApiSuccess(201, 'Deposit recorded (Location points at the transaction)', DEPOSIT_EXAMPLE)
  @ApiProblems(
    'IDEMPOTENCY_KEY_REQUIRED',
    'IDEMPOTENCY_KEY_INVALID',
    'UNSUPPORTED_CURRENCY',
    'VALIDATION_ERROR',
    'WALLET_NOT_FOUND',
    'AMOUNT_LIMIT_EXCEEDED',
    'IDEMPOTENCY_KEY_REUSED',
    'RETRY_LATER',
  )
  async create(
    @Param('id', UuidParamPipe) walletId: string,
    @Body() dto: CreateDepositDto,
    @Headers('idempotency-key') keyHeader: unknown,
    @Req() req: Request & { id?: string },
    @Res() res: Response,
  ): Promise<void> {
    const key = parseIdempotencyKey(keyHeader);
    const result = await this.deposits.deposit(walletId, dto, key, req.id ?? 'unknown');
    sendIdempotentResponse(res, result, paymentLocation(result.statusCode, result.body));
  }
}

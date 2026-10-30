import { Body, Controller, Headers, Param, Post, Req, Res } from '@nestjs/common';
import { ApiHeader, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { UuidParamPipe } from '../../common/http/uuid-param.pipe';
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
  @ApiHeader({ name: 'Idempotency-Key', required: true })
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

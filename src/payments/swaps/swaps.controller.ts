import { Body, Controller, Headers, Param, Post, Req, Res } from '@nestjs/common';
import { ApiHeader, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { UuidParamPipe } from '../../common/http/uuid-param.pipe';
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
  @ApiHeader({ name: 'Idempotency-Key', required: true })
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

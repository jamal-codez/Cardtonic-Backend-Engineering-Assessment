import { Controller, Get, Param } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { UuidParamPipe } from '../common/http/uuid-param.pipe';
import { TransactionDetailService } from './transaction-detail.service';
import type { TransactionDetail } from './transaction.mapper';

@ApiTags('transactions')
@Controller('transactions')
export class TransactionsController {
  constructor(private readonly detail: TransactionDetailService) {}

  @Get(':id')
  get(@Param('id', UuidParamPipe) id: string): Promise<TransactionDetail> {
    return this.detail.get(id);
  }
}

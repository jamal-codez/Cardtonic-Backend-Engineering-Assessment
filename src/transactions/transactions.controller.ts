import { Controller, Get, Param } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ApiProblems, ApiSuccess, ApiSummary } from '../common/http/api-docs';
import { UuidParamPipe } from '../common/http/uuid-param.pipe';
import { TRANSACTION_DETAIL_EXAMPLE } from '../docs/examples';
import { TransactionDetailService } from './transaction-detail.service';
import type { TransactionDetail } from './transaction.mapper';

@ApiTags('transactions')
@Controller('transactions')
export class TransactionsController {
  constructor(private readonly detail: TransactionDetailService) {}

  @Get(':id')
  @ApiSummary(
    'Transaction detail',
    'Includes the signed ledger entries; they sum to zero per currency.',
  )
  @ApiSuccess(200, 'The transaction', TRANSACTION_DETAIL_EXAMPLE)
  @ApiProblems('VALIDATION_ERROR', 'TRANSACTION_NOT_FOUND')
  get(@Param('id', UuidParamPipe) id: string): Promise<TransactionDetail> {
    return this.detail.get(id);
  }
}

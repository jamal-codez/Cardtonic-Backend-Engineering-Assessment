import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ApiProblems, ApiSuccess, ApiSummary } from '../common/http/api-docs';
import { UuidParamPipe } from '../common/http/uuid-param.pipe';
import { HISTORY_EXAMPLE } from '../docs/examples';
import { HistoryQueryDto } from './dto/history-query.dto';
import { HistoryService, type HistoryPage } from './history.service';

@ApiTags('transactions')
@Controller('wallets/:id/transactions')
export class HistoryController {
  constructor(private readonly history: HistoryService) {}

  @Get()
  @ApiSummary(
    'Wallet history, newest first',
    'Keyset pagination: pass next_cursor back as cursor. Optional filters: type, currency (either side).',
  )
  @ApiSuccess(200, 'One page of activity', HISTORY_EXAMPLE)
  @ApiProblems('VALIDATION_ERROR', 'UNSUPPORTED_CURRENCY', 'INVALID_CURSOR', 'WALLET_NOT_FOUND')
  list(
    @Param('id', UuidParamPipe) walletId: string,
    @Query() query: HistoryQueryDto,
  ): Promise<HistoryPage> {
    return this.history.list(walletId, query);
  }
}

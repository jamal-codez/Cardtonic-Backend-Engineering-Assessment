import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { UuidParamPipe } from '../common/http/uuid-param.pipe';
import { HistoryQueryDto } from './dto/history-query.dto';
import { HistoryService, type HistoryPage } from './history.service';

@ApiTags('transactions')
@Controller('wallets/:id/transactions')
export class HistoryController {
  constructor(private readonly history: HistoryService) {}

  @Get()
  list(
    @Param('id', UuidParamPipe) walletId: string,
    @Query() query: HistoryQueryDto,
  ): Promise<HistoryPage> {
    return this.history.list(walletId, query);
  }
}

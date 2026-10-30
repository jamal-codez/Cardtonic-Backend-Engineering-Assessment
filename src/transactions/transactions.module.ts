import { Module } from '@nestjs/common';
import { HistoryController } from './history.controller';
import { HistoryService } from './history.service';
import { TransactionDetailService } from './transaction-detail.service';
import { TransactionsController } from './transactions.controller';

@Module({
  controllers: [HistoryController, TransactionsController],
  providers: [HistoryService, TransactionDetailService],
})
export class TransactionsModule {}

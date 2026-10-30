import { Module } from '@nestjs/common';
import { LedgerService } from './ledger.service';
import { ReconciliationController } from './reconciliation.controller';
import { ReconciliationScheduler } from './reconciliation.scheduler';
import { ReconciliationService } from './reconciliation.service';

@Module({
  controllers: [ReconciliationController],
  providers: [LedgerService, ReconciliationService, ReconciliationScheduler],
  exports: [LedgerService, ReconciliationService],
})
export class LedgerModule {}

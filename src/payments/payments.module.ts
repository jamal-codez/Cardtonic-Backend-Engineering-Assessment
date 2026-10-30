import { Module } from '@nestjs/common';
import { IdempotencyModule } from '../idempotency/idempotency.module';
import { LedgerModule } from '../ledger/ledger.module';
import { DepositsController } from './deposits/deposits.controller';
import { DepositsService } from './deposits/deposits.service';

@Module({
  imports: [LedgerModule, IdempotencyModule],
  controllers: [DepositsController],
  providers: [DepositsService],
})
export class PaymentsModule {}

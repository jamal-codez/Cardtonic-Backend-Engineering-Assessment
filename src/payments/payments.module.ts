import { Module } from '@nestjs/common';
import { FxModule } from '../fx/fx.module';
import { IdempotencyModule } from '../idempotency/idempotency.module';
import { LedgerModule } from '../ledger/ledger.module';
import { ConversionService } from './conversion/conversion.service';
import { DepositsController } from './deposits/deposits.controller';
import { DepositsService } from './deposits/deposits.service';
import { SwapsController } from './swaps/swaps.controller';
import { SwapsService } from './swaps/swaps.service';

@Module({
  imports: [LedgerModule, IdempotencyModule, FxModule],
  controllers: [DepositsController, SwapsController],
  providers: [DepositsService, SwapsService, ConversionService],
  exports: [ConversionService],
})
export class PaymentsModule {}

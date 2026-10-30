import { Module } from '@nestjs/common';
import { FxModule } from '../fx/fx.module';
import { LedgerModule } from '../ledger/ledger.module';
import { WalletsController } from './wallets.controller';
import { WalletsService } from './wallets.service';

@Module({
  imports: [LedgerModule, FxModule],
  controllers: [WalletsController],
  providers: [WalletsService],
  exports: [WalletsService],
})
export class WalletsModule {}

import { Module } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../common/config/config';
import { FxController } from './fx.controller';
import { FX_PROVIDER, type FxProvider } from './fx-provider';
import { FxRefreshScheduler } from './fx-refresh.scheduler';
import { FxSnapshotStore } from './fx-snapshot.store';
import { RateService } from './rate.service';
import { SimulatedFxProvider } from './simulated-fx-provider';
import { StaticFxProvider } from './static-fx-provider';

@Module({
  controllers: [FxController],
  providers: [
    StaticFxProvider,
    SimulatedFxProvider,
    FxSnapshotStore,
    {
      provide: FX_PROVIDER,
      inject: [APP_CONFIG, StaticFxProvider, SimulatedFxProvider],
      useFactory: (
        config: AppConfig,
        staticProvider: StaticFxProvider,
        simulatedProvider: SimulatedFxProvider,
      ): FxProvider => (config.FX_PROVIDER === 'simulated' ? simulatedProvider : staticProvider),
    },
    RateService,
    FxRefreshScheduler,
  ],
  exports: [RateService],
})
export class FxModule {}

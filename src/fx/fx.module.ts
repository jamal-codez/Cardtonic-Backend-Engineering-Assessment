import { Module } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../common/config/config';
import { FxController } from './fx.controller';
import { FX_PROVIDER, type FxProvider } from './fx-provider';
import { FxRefreshScheduler } from './fx-refresh.scheduler';
import { FxSnapshotStore } from './fx-snapshot.store';
import { RateService } from './rate.service';
import { StaticFxProvider } from './static-fx-provider';

@Module({
  controllers: [FxController],
  providers: [
    StaticFxProvider,
    FxSnapshotStore,
    {
      provide: FX_PROVIDER,
      inject: [APP_CONFIG, StaticFxProvider],
      useFactory: (config: AppConfig, staticProvider: StaticFxProvider): FxProvider => {
        if (config.FX_PROVIDER === 'live') {
          throw new Error('FX_PROVIDER=live is not available yet; set FX_PROVIDER=static');
        }
        return staticProvider;
      },
    },
    RateService,
    FxRefreshScheduler,
  ],
  exports: [RateService],
})
export class FxModule {}

import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { APP_CONFIG, type AppConfig } from '../common/config/config';
import { RateService } from './rate.service';

const INTERVAL_NAME = 'fx-refresh';

/** Refreshes rates in the background so no request ever waits on a provider. */
@Injectable()
export class FxRefreshScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(FxRefreshScheduler.name);

  constructor(
    private readonly rates: RateService,
    private readonly registry: SchedulerRegistry,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onModuleInit(): void {
    if (!this.config.SCHEDULERS_ENABLED) return;
    const handle = setInterval(() => void this.tick(), this.config.FX_REFRESH_INTERVAL_MS);
    handle.unref();
    this.registry.addInterval(INTERVAL_NAME, handle);
  }

  onModuleDestroy(): void {
    if (this.registry.doesExist('interval', INTERVAL_NAME)) {
      this.registry.deleteInterval(INTERVAL_NAME);
    }
  }

  /** Public so tests can call the job directly. A failed refresh keeps the last snapshot. */
  async tick(): Promise<void> {
    try {
      await this.rates.refresh();
    } catch (error) {
      this.logger.error({ err: error }, 'FX refresh failed; keeping the previous snapshot');
    }
  }
}

import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Cron, SchedulerRegistry } from '@nestjs/schedule';
import { APP_CONFIG, type AppConfig } from '../common/config/config';
import { ReconciliationService } from './reconciliation.service';
import { isSkipped, type ReconMode } from './reconciliation.types';

const INCREMENTAL_NAME = 'reconciliation-incremental';

/**
 * Incremental reconciliation every RECON_INTERVAL_MS and a full one daily at 02:00 UTC, only when
 * SCHEDULERS_ENABLED. Several replicas are safe: the advisory lock lets only one run at a time.
 */
@Injectable()
export class ReconciliationScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ReconciliationScheduler.name);

  constructor(
    private readonly reconciliation: ReconciliationService,
    private readonly registry: SchedulerRegistry,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onModuleInit(): void {
    if (!this.config.SCHEDULERS_ENABLED) return;
    const handle = setInterval(
      () => void this.runScheduled('incremental'),
      this.config.RECON_INTERVAL_MS,
    );
    handle.unref();
    this.registry.addInterval(INCREMENTAL_NAME, handle);
  }

  onModuleDestroy(): void {
    if (this.registry.doesExist('interval', INCREMENTAL_NAME)) {
      this.registry.deleteInterval(INCREMENTAL_NAME);
    }
  }

  /** The cron decorator is static, so the handler itself checks the switch. */
  @Cron('0 2 * * *', { name: 'reconciliation-full', timeZone: 'UTC' })
  async dailyFull(): Promise<void> {
    if (!this.config.SCHEDULERS_ENABLED) return;
    await this.runScheduled('full');
  }

  /** Public so tests can call the job directly. A failed run is logged, never thrown. */
  async runScheduled(mode: ReconMode): Promise<void> {
    try {
      const result = await this.reconciliation.run(mode);
      if (isSkipped(result)) {
        this.logger.log({ mode }, 'Reconciliation skipped: another run is in progress');
      }
    } catch (error) {
      this.logger.error({ err: error, mode }, 'Reconciliation run failed');
    }
  }
}

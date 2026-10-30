import type { SchedulerRegistry } from '@nestjs/schedule';
import type { AppConfig } from '../common/config/config';
import { ReconciliationScheduler } from './reconciliation.scheduler';
import type { ReconciliationService } from './reconciliation.service';

function setup(schedulersEnabled: boolean) {
  const run = jest.fn<Promise<{ skipped: boolean }>, [string]>(() =>
    Promise.resolve({ skipped: false }),
  );
  const registry = {
    addInterval: jest.fn(),
    doesExist: jest.fn(() => false),
    deleteInterval: jest.fn(),
  };
  const config = { SCHEDULERS_ENABLED: schedulersEnabled, RECON_INTERVAL_MS: 300_000 };
  const scheduler = new ReconciliationScheduler(
    { run } as unknown as ReconciliationService,
    registry as unknown as SchedulerRegistry,
    config as AppConfig,
  );
  return { scheduler, run, registry };
}

describe('ReconciliationScheduler', () => {
  it('registers no interval when schedulers are off', () => {
    const { scheduler, registry } = setup(false);
    scheduler.onModuleInit();
    expect(registry.addInterval).not.toHaveBeenCalled();
  });

  it('registers the incremental interval when schedulers are on', () => {
    const { scheduler, registry } = setup(true);
    scheduler.onModuleInit();
    expect(registry.addInterval).toHaveBeenCalledTimes(1);
    const call = registry.addInterval.mock.calls[0] as unknown as [string, NodeJS.Timeout];
    clearInterval(call[1]);
  });

  it('the daily full run does nothing when schedulers are off', async () => {
    const { scheduler, run } = setup(false);
    await scheduler.dailyFull();
    expect(run).not.toHaveBeenCalled();
  });

  it('the daily full run runs a full reconciliation when schedulers are on', async () => {
    const { scheduler, run } = setup(true);
    await scheduler.dailyFull();
    expect(run).toHaveBeenCalledWith('full');
  });

  it('runScheduled never throws when a run fails, and does not throw when skipped', async () => {
    const { scheduler, run } = setup(true);
    jest.spyOn(scheduler['logger'], 'error').mockImplementation(() => undefined);
    jest.spyOn(scheduler['logger'], 'log').mockImplementation(() => undefined);
    run.mockRejectedValueOnce(new Error('database down'));
    await expect(scheduler.runScheduled('incremental')).resolves.toBeUndefined();
    run.mockResolvedValueOnce({ skipped: true });
    await expect(scheduler.runScheduled('incremental')).resolves.toBeUndefined();
  });
});

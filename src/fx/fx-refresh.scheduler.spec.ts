import type { SchedulerRegistry } from '@nestjs/schedule';
import type { AppConfig } from '../common/config/config';
import { FxRefreshScheduler } from './fx-refresh.scheduler';
import type { RateService } from './rate.service';

function setup(schedulersEnabled: boolean) {
  const rates = { refresh: jest.fn(() => Promise.resolve()) };
  const registry = {
    addInterval: jest.fn(),
    doesExist: jest.fn(() => false),
    deleteInterval: jest.fn(),
  };
  const config = { SCHEDULERS_ENABLED: schedulersEnabled, FX_REFRESH_INTERVAL_MS: 60_000 };
  const scheduler = new FxRefreshScheduler(
    rates as unknown as RateService,
    registry as unknown as SchedulerRegistry,
    config as AppConfig,
  );
  return { scheduler, rates, registry };
}

describe('FxRefreshScheduler', () => {
  it('registers no interval when schedulers are off', () => {
    const { scheduler, registry } = setup(false);
    scheduler.onModuleInit();
    expect(registry.addInterval).not.toHaveBeenCalled();
  });

  it('registers the refresh interval when schedulers are on', () => {
    const { scheduler, registry } = setup(true);
    scheduler.onModuleInit();
    expect(registry.addInterval).toHaveBeenCalledTimes(1);
    const call = registry.addInterval.mock.calls[0] as unknown as [string, NodeJS.Timeout];
    clearInterval(call[1]);
  });

  it('tick() refreshes the rates', async () => {
    const { scheduler, rates } = setup(true);
    await scheduler.tick();
    expect(rates.refresh).toHaveBeenCalledTimes(1);
  });

  it('tick() never throws when a refresh fails', async () => {
    const { scheduler, rates } = setup(true);
    rates.refresh.mockRejectedValueOnce(new Error('provider down'));
    jest.spyOn(scheduler['logger'], 'error').mockImplementation(() => undefined);
    await expect(scheduler.tick()).resolves.toBeUndefined();
  });
});

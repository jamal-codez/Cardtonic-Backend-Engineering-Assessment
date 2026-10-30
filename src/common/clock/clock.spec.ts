import { FakeClock } from './clock';

describe('FakeClock', () => {
  it('advance moves time forward by the given milliseconds', () => {
    const clock = new FakeClock(new Date('2026-01-01T00:00:00.000Z'));
    clock.advance(1500);
    expect(clock.now().toISOString()).toBe('2026-01-01T00:00:01.500Z');
  });

  it('set replaces the current time', () => {
    const clock = new FakeClock();
    clock.set(new Date('2030-05-05T10:00:00.000Z'));
    expect(clock.now().toISOString()).toBe('2030-05-05T10:00:00.000Z');
  });

  it('does not let callers mutate its internal time through a returned date', () => {
    const clock = new FakeClock(new Date('2026-01-01T00:00:00.000Z'));
    clock.now().setFullYear(1999);
    expect(clock.now().getUTCFullYear()).toBe(2026);
  });
});

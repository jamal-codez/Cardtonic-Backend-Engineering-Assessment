import { AppError } from '../common/errors/app-error';
import { decodeCursor, encodeCursor } from './cursor';

const ID = '01a18e56-7952-729f-ab7d-cb9426c0fd98';
const T = '2026-03-03T12:00:00.123456Z';

const b64 = (value: unknown): string =>
  Buffer.from(typeof value === 'string' ? value : JSON.stringify(value), 'utf8').toString(
    'base64url',
  );

function errorCode(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    return error instanceof AppError ? error.code : 'NOT_APP_ERROR';
  }
  return undefined;
}

describe('history cursor', () => {
  it('round-trips, keeping microsecond precision', () => {
    expect(decodeCursor(encodeCursor({ t: T, id: ID }))).toEqual({ t: T, id: ID });
  });

  it('accepts a real leap day', () => {
    expect(decodeCursor(encodeCursor({ t: '2024-02-29T23:59:59.999999Z', id: ID })).t).toBe(
      '2024-02-29T23:59:59.999999Z',
    );
  });

  it('accepts timestamps with 0 to 6 fractional digits', () => {
    for (const t of [
      '2026-03-03T12:00:00Z',
      '2026-03-03T12:00:00.1Z',
      '2026-03-03T12:00:00.123Z',
    ]) {
      expect(decodeCursor(encodeCursor({ t, id: ID })).t).toBe(t);
    }
  });

  it.each([
    ['an empty string', ''],
    ['characters outside base64url', 'abc+/=='],
    ['padding', `${encodeCursor({ t: T, id: ID })}==`],
    ['not JSON', b64('not json')],
    ['a JSON array', b64([T, ID])],
    ['JSON null', b64('null')],
    ['a missing key', b64({ t: T })],
    ['an extra key', b64({ t: T, id: ID, extra: 1 })],
    ['a numeric timestamp', b64({ t: 1700000000000, id: ID })],
    ['a bad timestamp', b64({ t: 'yesterday', id: ID })],
    ['an impossible date', b64({ t: '2026-13-45T25:61:61Z', id: ID })],
    ['a calendar-invalid day (31 February)', b64({ t: '2023-02-31T00:00:00.123456Z', id: ID })],
    ['a day 30 of February in a leap year', b64({ t: '2024-02-30T00:00:00Z', id: ID })],
    ['year zero', b64({ t: '0000-01-01T00:00:00Z', id: ID })],
    ['hour 24', b64({ t: '2026-03-03T24:00:00Z', id: ID })],
    ['seven fractional digits', b64({ t: '2026-03-03T12:00:00.1234567Z', id: ID })],
    ['a timestamp with an offset', b64({ t: '2026-03-03T12:00:00+01:00', id: ID })],
    ['a bad uuid', b64({ t: T, id: 'not-a-uuid' })],
    ['an upper-case uuid (not canonical)', b64({ t: T, id: ID.toUpperCase() })],
    ['a SQL injection attempt in id', b64({ t: T, id: `${ID}'; DROP TABLE wallets;--` })],
    ['non-canonical key order', b64(`{"id":"${ID}","t":"${T}"}`)],
    ['whitespace in the JSON', b64(`{"t": "${T}","id":"${ID}"}`)],
    ['an oversized value', 'A'.repeat(201)],
  ])('rejects %s with INVALID_CURSOR', (_label, raw) => {
    expect(errorCode(() => decodeCursor(raw))).toBe('INVALID_CURSOR');
  });
});

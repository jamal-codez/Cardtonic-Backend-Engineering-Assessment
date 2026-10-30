import { AppError } from '../common/errors/app-error';

const BASE64URL = /^[A-Za-z0-9_-]+$/;
/** ISO 8601 UTC with up to microsecond precision, as produced by the history query. */
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_CURSOR_LENGTH = 200;

export interface HistoryCursor {
  /** created_at with microsecond precision: a millisecond Date would skip or repeat rows. */
  t: string;
  id: string;
}

export function encodeCursor(cursor: HistoryCursor): string {
  return Buffer.from(JSON.stringify({ t: cursor.t, id: cursor.id }), 'utf8').toString('base64url');
}

/**
 * A date that V8 accepts but Postgres rejects (2023-02-31, year 0000) must not get through: the
 * database would answer with an error and the client would see a 500, not INVALID_CURSOR.
 */
function isRealTimestamp(t: string): boolean {
  const seconds = `${t.slice(0, 19)}Z`;
  const parsed = new Date(seconds);
  return (
    !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 19) === t.slice(0, 19) &&
    !t.startsWith('0000')
  );
}

const invalid = (): AppError =>
  new AppError('INVALID_CURSOR', { detail: 'The pagination cursor is invalid' });

/**
 * Strict decoder: anything that is not exactly what `encodeCursor` produces is rejected, so a
 * tampered cursor can never reach the database.
 */
export function decodeCursor(raw: string): HistoryCursor {
  if (raw.length === 0 || raw.length > MAX_CURSOR_LENGTH || !BASE64URL.test(raw)) throw invalid();

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw invalid();
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw invalid();

  const keys = Object.keys(parsed).sort();
  if (keys.length !== 2 || keys[0] !== 'id' || keys[1] !== 't') throw invalid();
  const { t, id } = parsed as Record<string, unknown>;
  if (typeof t !== 'string' || !ISO_UTC.test(t) || !isRealTimestamp(t)) throw invalid();
  if (typeof id !== 'string' || !UUID.test(id)) throw invalid();

  const cursor = { t, id };
  // Canonical form only: no extra whitespace, key order or padding variants.
  if (encodeCursor(cursor) !== raw) throw invalid();
  return cursor;
}

import { createHash } from 'node:crypto';

/** JSON with recursively sorted object keys, so equal requests always serialise identically. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('cannot hash a non-finite number');
    return JSON.stringify(value);
  }
  if (typeof value === 'bigint') return JSON.stringify(value.toString());
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
    return `{${entries.join(',')}}`;
  }
  throw new TypeError(`cannot hash a value of type ${typeof value}`);
}

/**
 * sha256 of the canonical JSON of `{ scope, body }`. `body` must already be normalised (canonical
 * currency codes, amounts printed with 6 decimals), so equivalent requests hash the same.
 */
export function hashRequest(scope: string, body: unknown): string {
  return createHash('sha256').update(canonicalJson({ scope, body })).digest('hex');
}

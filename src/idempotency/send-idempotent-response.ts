import type { Response } from 'express';
import type { ExecuteResult } from './idempotency.service';

/**
 * Sends the stored body as a pre-serialised string so a replay is byte-identical to the original
 * response. Stored rejections go out as problem+json.
 */
export function sendIdempotentResponse(
  res: Response,
  result: ExecuteResult,
  location?: string,
): void {
  if (location) res.setHeader('Location', location);
  if (result.replayed) res.setHeader('Idempotent-Replayed', 'true');
  res
    .status(result.statusCode)
    .type(result.statusCode >= 400 ? 'application/problem+json' : 'application/json')
    .send(JSON.stringify(result.body));
}

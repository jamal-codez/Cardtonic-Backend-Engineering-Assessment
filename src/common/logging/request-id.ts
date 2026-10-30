import type { NextFunction, Request, Response } from 'express';
import { v7 as uuidv7 } from 'uuid';

const VALID_REQUEST_ID = /^[\x21-\x7e]{1,128}$/;

export function resolveRequestId(incoming: unknown): string {
  if (typeof incoming === 'string' && VALID_REQUEST_ID.test(incoming)) return incoming;
  return uuidv7();
}

/**
 * Runs before the body parser so even a 413 or malformed-JSON response carries a request id.
 * pino-http's genReqId reuses the id set here.
 */
export function requestIdMiddleware(req: Request, res: Response, next: NextFunction): void {
  const id = resolveRequestId(req.headers['x-request-id']);
  (req as Request & { id?: string }).id = id;
  res.setHeader('X-Request-Id', id);
  next();
}

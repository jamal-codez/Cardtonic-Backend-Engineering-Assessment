import { applyDecorators } from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiResponse } from '@nestjs/swagger';
import type { SchemaObject } from '@nestjs/swagger/dist/interfaces/open-api-spec.interface';
import { ERROR_CATALOGUE, type ErrorCode } from '../errors/error-catalogue';
import { PROBLEM_EXAMPLE, VALIDATION_PROBLEM_EXAMPLE } from '../../docs/examples';

const PROBLEM_SCHEMA: SchemaObject = {
  type: 'object',
  required: ['type', 'title', 'status', 'detail', 'code', 'request_id'],
  properties: {
    type: { type: 'string', example: 'urn:problem:insufficient-funds' },
    title: { type: 'string' },
    status: { type: 'integer' },
    detail: { type: 'string' },
    code: { type: 'string' },
    request_id: { type: 'string' },
    errors: {
      type: 'array',
      description: 'Field errors, present for VALIDATION_ERROR',
      items: {
        type: 'object',
        properties: { field: { type: 'string' }, message: { type: 'string' } },
      },
    },
  },
};

/** Summary and description for one operation. */
export const ApiSummary = (summary: string, description?: string): MethodDecorator =>
  ApiOperation({ summary, ...(description ? { description } : {}) });

/** A success response with an example body. */
export const ApiSuccess = (
  status: number,
  description: string,
  example: unknown,
): MethodDecorator =>
  ApiResponse({ status, description, schema: { type: 'object', example: example } });

/**
 * Documents the error codes an endpoint can return, grouped by HTTP status (one OpenAPI response
 * per status, listing every code in its description). Statuses come from the error catalogue, so
 * the document cannot disagree with the code about a code's status.
 */
export function ApiProblems(...codes: ErrorCode[]): MethodDecorator & ClassDecorator {
  const byStatus = new Map<number, ErrorCode[]>();
  for (const code of codes) {
    const status = ERROR_CATALOGUE[code].status;
    byStatus.set(status, [...(byStatus.get(status) ?? []), code]);
  }
  const responses = [...byStatus.entries()]
    .sort(([a], [b]) => a - b)
    .map(([status, statusCodes]) =>
      ApiResponse({
        status,
        description: `application/problem+json. Codes: ${statusCodes.join(', ')}.${
          status === 503 ? ' Carries a Retry-After header.' : ''
        }`,
        content: {
          'application/problem+json': {
            schema: PROBLEM_SCHEMA,
            example:
              status === 400 && statusCodes.includes('VALIDATION_ERROR')
                ? VALIDATION_PROBLEM_EXAMPLE
                : {
                    ...PROBLEM_EXAMPLE,
                    status,
                    code: statusCodes[0],
                    title: ERROR_CATALOGUE[statusCodes[0] as ErrorCode].title,
                  },
          },
        },
      }),
    );
  return applyDecorators(...responses);
}

/** The Idempotency-Key header every money-moving POST requires. */
export const ApiIdempotencyKey = (): MethodDecorator =>
  ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description:
      'Unique per logical request (a UUID works). Retrying with the same key and body replays the original response and sets Idempotent-Replayed: true; the same key with a different body is 422 IDEMPOTENCY_KEY_REUSED.',
    schema: { type: 'string', example: '2f6c1e0a-8d4b-4a53-9c1e-7b3a5d9f0e12' },
  });

/** Codes any route can return; stated once in the API description rather than on every route. */
export const CROSS_CUTTING_CODES: ErrorCode[] = [
  'NOT_FOUND',
  'METHOD_NOT_ALLOWED',
  'PAYLOAD_TOO_LARGE',
  'RETRY_LATER',
  'INTERNAL_ERROR',
];

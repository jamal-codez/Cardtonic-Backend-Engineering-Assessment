import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { OpenAPIObject } from '@nestjs/swagger';
import { AppModule } from '../app.module';
import { configureApp } from '../configure-app';
import { ERROR_CATALOGUE, type ErrorCode } from '../common/errors/error-catalogue';
import { createOpenApiDocument } from './build-openapi';
import { buildPostmanCollection } from './postman';

const ROOT = join(__dirname, '..', '..');

interface Operation {
  summary?: string;
  parameters?: { name: string; in: string; required?: boolean }[];
  responses: Record<
    string,
    {
      description?: string;
      content?: Record<string, { example?: unknown; schema?: { example?: unknown } }>;
    }
  >;
}

describe('OpenAPI document', () => {
  let document: OpenAPIObject;
  let operations: { key: string; path: string; method: string; op: Operation }[];

  beforeAll(async () => {
    process.env['DATABASE_URL'] ??= 'postgres://unused:unused@127.0.0.1:1/unused';
    process.env['SCHEDULERS_ENABLED'] = 'false';
    // Created but never initialised, as in scripts/export-openapi.ts: no database is touched.
    const app = await NestFactory.create<NestExpressApplication>(AppModule, {
      logger: false,
      bodyParser: false,
    });
    configureApp(app);
    document = createOpenApiDocument(app);
    operations = Object.entries(document.paths).flatMap(([path, item]) =>
      (['get', 'post'] as const).flatMap((method) => {
        const op = (item as Record<string, Operation | undefined>)[method];
        return op ? [{ key: `${method.toUpperCase()} ${path}`, path, method, op }] : [];
      }),
    );
  }, 60_000);

  it('documents the eleven /v1 endpoints', () => {
    expect(operations.map((o) => o.key).sort()).toEqual(
      [
        'GET /v1/admin/reconciliation',
        'GET /v1/fx/rates',
        'GET /v1/transactions/{id}',
        'GET /v1/wallets/{id}',
        'GET /v1/wallets/{id}/transactions',
        'POST /v1/admin/reconciliation/run',
        'POST /v1/fx/quotes',
        'POST /v1/wallets',
        'POST /v1/wallets/{id}/deposits',
        'POST /v1/wallets/{id}/swaps',
        'POST /v1/wallets/{id}/transfers',
      ].sort(),
    );
  });

  it('gives every endpoint a summary and a success response with an example body', () => {
    for (const { key, op } of operations) {
      expect(op.summary).toBeTruthy();
      const success = Object.entries(op.responses).find(([status]) => status.startsWith('2'));
      expect(success).toBeDefined();
      const content = success?.[1].content?.['application/json'];
      expect(content?.schema?.example ?? content?.example).toBeDefined();
      expect(key).toBeTruthy();
    }
  });

  it('documents every error with a code from the catalogue under that code’s own status', () => {
    for (const { op } of operations) {
      for (const [status, response] of Object.entries(op.responses)) {
        if (status.startsWith('2')) continue;
        const listed = /Codes: ([A-Z_, ]+)\./.exec(response.description ?? '')?.[1];
        expect(listed).toBeDefined();
        for (const code of (listed ?? '').split(', ') as ErrorCode[]) {
          expect(ERROR_CATALOGUE[code]).toBeDefined();
          expect(String(ERROR_CATALOGUE[code].status)).toBe(status);
        }
      }
    }
  });

  it('requires the Idempotency-Key header on exactly the money-moving POSTs', () => {
    const withKey = operations
      .filter(({ op }) =>
        (op.parameters ?? []).some(
          (p) => p.in === 'header' && p.name === 'Idempotency-Key' && p.required,
        ),
      )
      .map((o) => o.key)
      .sort();
    expect(withKey).toEqual([
      'POST /v1/wallets/{id}/deposits',
      'POST /v1/wallets/{id}/swaps',
      'POST /v1/wallets/{id}/transfers',
    ]);
  });

  it('documents the idempotency and quote errors on swaps and transfers', () => {
    for (const key of ['POST /v1/wallets/{id}/swaps', 'POST /v1/wallets/{id}/transfers']) {
      const op = operations.find((o) => o.key === key)?.op;
      const text = Object.values(op?.responses ?? {})
        .map((r) => r.description)
        .join(' ');
      for (const code of [
        'IDEMPOTENCY_KEY_REQUIRED',
        'IDEMPOTENCY_KEY_REUSED',
        'INSUFFICIENT_FUNDS',
        'QUOTE_EXPIRED',
        'QUOTE_USED',
        'QUOTE_MISMATCH',
        'QUOTE_NOT_FOUND',
        'FX_UNAVAILABLE',
      ]) {
        expect(text).toContain(code);
      }
    }
  });

  it('matches openapi.json on disk (run `yarn openapi:export` after changing a route)', () => {
    const onDisk = readFileSync(join(ROOT, 'openapi.json'), 'utf8');
    expect(onDisk).toBe(`${JSON.stringify(document, null, 2)}\n`);
  });

  it('matches the Postman collection on disk', () => {
    const onDisk = readFileSync(
      join(ROOT, 'postman', 'borderless.postman_collection.json'),
      'utf8',
    );
    expect(onDisk).toBe(`${JSON.stringify(buildPostmanCollection(document), null, 2)}\n`);
  });
});

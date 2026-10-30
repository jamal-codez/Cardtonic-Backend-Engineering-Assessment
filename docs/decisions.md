# Decision log

Template for each entry: Context, Options, Decision, Consequences.

## D1. NestJS 11 (CommonJS) instead of the registry's latest 12.x

- **Context:** CLAUDE.md says "NestJS (latest stable)". At scaffold time the registry's latest, 12.x, is ESM-only.
- **Options:** (a) Nest 12 with a NodeNext/ESM project, `.js` import suffixes and Jest's experimental ESM mode. (b) Nest 11, the latest CommonJS line.
- **Decision:** Nest 11 and its matching ecosystem packages (`@nestjs/swagger` 11, `@nestjs/schedule` 6, `nestjs-pino` 4, `uuid` 11). TypeScript is pinned to 5.9 because `typescript-eslint` and `ts-jest` do not support 7.
- **Consequences:** Departs from "latest stable" by one major version. Avoids ESM tooling risk in Jest, Testcontainers and Drizzle. Upgrading later is a contained migration.

## D2. Hand-written scaffold instead of `nest new`

- **Context:** The spec wants the sample controller removed and exact tsconfig flags.
- **Decision:** Write every file by hand; no `@nestjs/cli` dependency (not in the stack table). `yarn dev` uses `node --watch` with `ts-node` transpile-only.
- **Consequences:** `yarn dev` does not typecheck; `yarn typecheck` and CI do.

## D3. Shared `configureApp()` for production and tests

- **Context:** Integration tests must exercise the real wiring (pipes, filter, body limit, prefix).
- **Decision:** `src/configure-app.ts` is called by both `main.ts` and `createTestApp()`. Swagger is set up only in `main.ts`.
- **Consequences:** No drift between test and production setup.

## D4. Request id middleware runs before the body parser

- **Context:** A 413 or malformed-JSON error is raised by the body parser, before Nest middleware, so a request id set later would be missing from that problem response.
- **Decision:** `requestIdMiddleware` sets `req.id` and `X-Request-Id` first; the pino `genReqId` reuses `req.id`.
- **Consequences:** Every response, including body-parser failures, carries a request id.

## D5. Transport-level error codes outside the domain catalogue

- **Context:** The section 6 catalogue has no code for an unknown route (404), unsupported method (405) or an oversized body (413).
- **Options:** Reuse `VALIDATION_ERROR` for everything, or add transport codes.
- **Decision:** Added `NOT_FOUND`, `METHOD_NOT_ALLOWED` and `PAYLOAD_TOO_LARGE`. Other 4xx `HttpException`s and malformed JSON map to `VALIDATION_ERROR`.
- **Consequences:** Small, documented extension of the catalogue; the domain codes are untouched.

## D6. Request timeout does not cancel the handler

- **Context:** After `REQUEST_TIMEOUT_MS` the client gets 503 `RETRY_LATER`, but the handler keeps running.
- **Decision:** Accept it. Money endpoints run in a single transaction that either commits or rolls back, and they require an idempotency key, so the client retries with the same key and gets the stored result.
- **Consequences:** A late commit after the 503 is possible, which is exactly why idempotency is mandatory. The `statement_timeout` (5s) and `lock_timeout` (2s) keep transactions shorter than the request timeout.

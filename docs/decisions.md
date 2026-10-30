# Decision log

Template for each entry: Context, Options, Decision, Consequences.

## D1. NestJS 11 (CommonJS) instead of the registry's latest 12.x

- **Context:** The registry's latest, 12.x, is ESM-only.
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

## D7. Amounts are BIGINT minor units at scale 6

- **Context:** Money must be exact and the API deals in stablecoins with up to 6 decimals.
- **Options:** (a) `numeric(30,6)` columns. (b) `bigint` minor units (1 unit = 1,000,000). (c) Floats (rejected outright).
- **Decision:** `bigint` everywhere (columns, `bigint` in TypeScript, drizzle `mode: 'bigint'`), scale 6 for every currency. The largest allowed amount, 1,000,000,000 units, is 10^15 minor units, far below the bigint limit of about 9.2 x 10^18, so a single amount cannot overflow. Out-of-range sums raise `22003`, mapped to `AMOUNT_LIMIT_EXCEEDED`.
- **Consequences:** No rounding inside the ledger; rounding happens in one place (`convert`, floor). JSON never carries a bigint; amounts go out as 6-decimal strings. Cost: a different scale per currency would need a schema and helper change.

## D8. Stored balances plus entries, not balance-by-summing

- **Context:** A balance can be computed by summing a wallet's entries, or kept as a stored column.
- **Options:** (a) Sum entries on every read. (b) Stored balance on the account, updated in the same transaction as the entries.
- **Decision:** (b) for user accounts. The row lock taken for the update also serialises overdraft checks, and reads are O(1).
- **Consequences:** Two sources of truth that must agree. The `CHECK (balance >= 0)` is the database backstop against overdrafts, and reconciliation (phase 7) verifies stored balance equals the sum of entries. A deferred trigger that re-sums a wallet's entries on every balance update was considered and rejected: it would scan an ever-growing entries table inside every transaction. Reconciliation is the guard for balance drift; the posting engine is the only writer.

## D9. System accounts have no stored balance

- **Context:** Every deposit touches `external`, every swap touches `fx_pool`. A stored, locked balance there would be touched by every transaction.
- **Options:** (a) Stored balance, locked like user accounts. (b) NULL balance; the balance is the sum of the account's entries.
- **Decision:** (b). System accounts are never locked and never updated; the entries are inserted without contention.
- **Consequences:** With (a), every posting would queue on the same one or two rows, so throughput would be capped by a single lock and a long transaction would stall the whole system. Cost: a system account's balance needs an aggregate query, which is fine for the occasional reconciliation. The `CHECK ((kind = 'user') = (balance IS NOT NULL))` makes the rule structural.

## D10. Invariants are enforced by the database, then re-checked in code

- **Context:** The application will have bugs; the ledger must not be corruptible by them.
- **Decision:** Constraints and triggers do the enforcing; the posting engine fails fast first so errors are readable. In the database: a deferred constraint trigger asserts entries sum to zero per currency at COMMIT; a second deferred trigger asserts at least two entries per transaction (it catches a transaction with no entries, which the first trigger never sees); `BEFORE UPDATE OR DELETE` triggers make `transactions`, `ledger_entries` and `wallet_activity` append-only (`0A000`); `CHECK`s keep user balances non-negative and tie `kind`, `balance` and `wallet_id` together; a composite foreign key `ledger_entries(account_id, currency) -> accounts(id, currency)` stops an entry carrying a different currency than its account. The last one goes beyond the written spec.
- **Consequences:** Deferred trigger errors surface at `COMMIT`; `withTransaction` lets them propagate and does not retry them (`23514`). `TRUNCATE` bypasses row triggers, which the test reset helper relies on, so a production role must not hold `TRUNCATE` rights. `transactions.initiator_wallet_id` and `wallet_activity.wallet_id` have no foreign key, as written in the spec.

## D11. Frozen wallets can still receive

- **Context:** A frozen wallet should not be able to move money out.
- **Decision:** Debits from a frozen wallet raise `WALLET_FROZEN`; credits are allowed. The check runs on debited wallets only, after the overdraft check, as specified.
- **Consequences:** Incoming transfers and deposits keep working, so the sender is never blocked by the recipient's state, and a freeze cannot strand funds that arrive later. The status is read without a lock: there is no freeze endpoint yet, so a concurrent freeze cannot race. When one is added, read the status with `FOR SHARE` or re-check after locking.

## D12. Migrations and seed live in `src/db`, not `scripts/`

- **Context:** The production image runs compiled code only, and `tsconfig.build.json` compiles `src/` into `dist/` with `main.js` at the top (required by `yarn start`).
- **Decision:** `src/db/migrate.ts` and `src/db/seed.ts` compile to `dist/db/`. The entrypoint runs `node dist/db/migrate.js`, then `node dist/db/seed.js`, then `exec node dist/main.js`. `yarn db:migrate` and `yarn db:seed` run the TypeScript directly. The migrate script holds `pg_advisory_lock(727001)` on a dedicated connection, so replicas starting together migrate one at a time. The SQL lives in `drizzle/`, copied into the runtime image.
- **Consequences:** The `scripts/` directory keeps only the shell entrypoint.

## D13. System account ids are cached in memory

- **Context:** `getSystemAccountId` is called on every posting.
- **Decision:** Cache after the first lookup, because system accounts never change after seeding. The test reset helper truncates and reseeds, which creates new ids, so it also calls `clearSystemAccountCache()`.
- **Consequences:** A process that outlives a reseed would use stale ids; only tests reseed.

## D14. Activity rows take `now()` from the database

- **Context:** The activity row's `created_at` must equal the transaction's. Passing back the JS `Date` from `RETURNING created_at` truncates microseconds to milliseconds, so the values differed by under a millisecond (found by an integration test).
- **Decision:** Insert activity rows with `created_at = now()`. `now()` is constant within one database transaction, so it equals the transaction's default exactly.
- **Consequences:** The `createdAt` returned to callers is millisecond-precise. Any keyset pagination over `(created_at, id)` must be built on the database value and not on a round-tripped JS `Date`.

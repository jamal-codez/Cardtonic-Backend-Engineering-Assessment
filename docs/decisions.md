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

## D15. The `Idempotency-Key` header is required on money endpoints

- **Context:** A client that times out after sending a deposit cannot know whether it was applied. Retrying without a key could credit twice.
- **Options:** (a) Optional key, with a best-effort duplicate guess from the body. (b) Required key.
- **Decision:** (b). A missing key is `400 IDEMPOTENCY_KEY_REQUIRED`; a key that is not 1 to 255 printable ASCII characters (`^[\x21-\x7E]{1,255}$`, so no spaces) is `400 IDEMPOTENCY_KEY_INVALID`. Neither is ever stored.
- **Consequences:** Clients must generate keys. A duplicate-looking request without a key cannot be told apart from a deliberate second deposit, which is why we do not guess.

## D16. Key scope, request hash and TTL

- **Context:** The same key string may be used by unrelated callers or reused for a different request.
- **Decision:** Scope is `wallet:{walletId}:{METHOD} {route template}`, so keys are per wallet and per endpoint. The hash is sha256 of the canonical JSON (recursively sorted keys) of `{ scope, body }`, where `body` is the parsed DTO with currency in canonical spelling and amount re-printed with 6 decimals, so `"10"` and `"10.0"` are the same request. Same key and different hash is `422 IDEMPOTENCY_KEY_REUSED`. Keys live for `IDEMPOTENCY_TTL_HOURS` (default 24); an expired key is re-claimed by the same `INSERT ... ON CONFLICT ... WHERE expires_at < now()` statement.
- **Consequences:** The `Idempotency-Key` header is the only input outside the hash, which is correct. Expiry is judged by the database clock. A cleanup job for expired rows is not built; re-claiming overwrites them lazily.

## D17. Business rejections are stored against the key; other failures are not

- **Context:** A retry of a request that was rejected for a business reason (for example `INSUFFICIENT_FUNDS`) should get the same answer, not a different one after the balance changed. A retry after a crash or timeout must be able to run.
- **Options:** (a) Store nothing on failure. (b) Store every error. (c) Store only business rejections.
- **Decision:** (c). A 422 `AppError` thrown by the work is stored and the key row is committed; 404, 5xx and unknown errors roll everything back, releasing the key. The work runs inside a savepoint so a rejection thrown after some writes undoes them before the key row commits.
- **Consequences:** Storing a 5xx would freeze a transient fault for 24 hours. The cost of (c) is that a rejected key stays rejected until it expires; the caller uses a new key to try again. A replayed rejection carries the current request's `request_id`.

## D18. Replays are byte-identical, even though `response_body` is `jsonb`

- **Context:** `jsonb` stores keys in its own order, so serialising what we stored would differ from what the first call serialised.
- **Decision:** After storing the body, the first response is read back from the row (`UPDATE ... RETURNING response_body`), and both the first response and every replay are sent as `JSON.stringify` of that value.
- **Consequences:** Key order in these responses follows `jsonb` (shorter keys first) rather than the order in the mapper. It is consistent, and clients must not depend on key order.

## D19. Wallet creation needs no idempotency key

- **Context:** `POST /v1/wallets` creates a resource identified by email or phone.
- **Decision:** No key. The unique constraints on `email` (citext) and `phone` already make the operation safe to retry: a repeated request is `409 WALLET_ALREADY_EXISTS`, never a second wallet. The 409 detail is generic and never says which identifier clashed or who owns it.
- **Consequences:** A client that lost the 201 gets a 409 on retry and then reads the wallet; there is nothing to look it up by without knowing the id, which is a deliberate privacy limit of this sandbox. The 409 still confirms that an identifier is registered (inherent to unique constraints), and `GET /v1/wallets/:id` returns the email and phone to anyone holding the id; there is no authentication in this sandbox.

## D20. Same-key waiters and `lock_timeout`

- **Context:** A second request with the same key blocks on the unique index until the first commits.
- **Decision:** Accept it. Typical requests take milliseconds. If the first takes longer than the 2s `lock_timeout`, the waiter hits `55P03`, `withTransaction` retries it up to 3 times, and then answers `503 RETRY_LATER`.
- **Consequences:** Concurrent duplicates cost one pooled connection each while they wait; the pool (10 by default) bounds how many can wait at once.

## D21. Drizzle wraps driver errors; the SQLSTATE is read from the cause chain

- **Context:** Drizzle throws a wrapper error whose `cause` is the original Postgres error, so a top-level `code` check missed it (found by the duplicate-wallet integration test, which got a 500 instead of a 409). The same gap would have disabled deadlock retries.
- **Decision:** `pgErrorCode` walks the `cause` chain (up to 5 levels). Retry, mapping and connection-error detection all use it.
- **Consequences:** One place defines how a database error is recognised.

## D22. Only the ledger opens accounts

- **Context:** The architecture rules say only `ledger/` writes account rows and balances.
- **Decision:** Wallet creation calls `LedgerService.openUserAccounts`, which inserts the five zero-balance accounts; `wallets/` writes the wallet row only.
- **Consequences:** `wallets/` depends on `ledger/`, not the other way round.

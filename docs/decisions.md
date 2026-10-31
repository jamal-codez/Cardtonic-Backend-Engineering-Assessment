# Decision log

The decisions that shape correctness, cost or scope, each with what was chosen and what it costs. Ids are stable references (the README links to them), so they are not contiguous: entries that only recorded implementation details were removed.

## Foundations

### D1. NestJS 11 (CommonJS), not the registry's 12.x
Nest 12 is ESM-only and would pull in ESM tooling risk for Jest, Testcontainers and Drizzle. Nest 11 and its matching packages avoid that. Cost: one major version behind "latest stable"; upgrading later is a contained migration.

### D6. A request timeout does not cancel the handler
After `REQUEST_TIMEOUT_MS` the client gets `503 RETRY_LATER` but the handler keeps running. Money endpoints are one transaction and need an idempotency key, so the client retries with the same key and gets the stored result. Cost: a late commit after the 503 is possible, which is exactly why idempotency is mandatory.

## Ledger

### D8. Stored balances plus entries
User accounts keep a stored balance updated in the same transaction as the entries. The row lock also serialises overdraft checks and reads are O(1). Cost: two sources of truth that must agree; `CHECK (balance >= 0)` is the backstop and reconciliation compares them. A trigger that re-sums entries on every update was rejected: it would scan an ever-growing table inside every transaction.

### D9. System accounts have no stored balance
`external` and `fx_pool` have a `NULL` balance (their balance is the sum of their entries) and are never locked, so deposits and swaps on different wallets never queue on one row. Cost: their balance needs an aggregate query, fine for occasional reconciliation. A `CHECK` makes the rule structural.

### D10. The database enforces the invariants; the code re-checks first
A deferred trigger asserts entries sum to zero per currency at `COMMIT`; a second asserts at least two entries; `transactions`, `ledger_entries` and `wallet_activity` are append-only by trigger; `CHECK`s keep user balances non-negative; a composite foreign key stops an entry carrying a different currency from its account. The posting engine fails fast first so errors are readable. Cost: deferred errors surface at `COMMIT` (not retried), and `TRUNCATE` bypasses the triggers, so a production role must not hold it.

### D11. Frozen wallets can still receive
Debits from a frozen wallet raise `WALLET_FROZEN`; credits are allowed, so a freeze cannot strand incoming funds. Cost: the status is read without a lock. There is no freeze endpoint (only reconciliation can freeze), so a freeze cannot race today; one would need `FOR SHARE` or a re-check after locking.

### D22. Only the ledger opens accounts
Wallet creation calls `LedgerService.openUserAccounts`; `wallets/` writes the wallet row only, so `ledger/` stays the sole writer of accounts and balances.

## Idempotency

### D16. Key scope, request hash and TTL
Scope is `wallet:{id}:{METHOD} {route}`; the hash is sha256 of the canonical JSON of `{ scope, body }` with currency and amount normalised (`"10"` and `"10.0"` match). The same key with another hash is `422 IDEMPOTENCY_KEY_REUSED`. Keys live 24 hours (`IDEMPOTENCY_TTL_HOURS`) and an expired key is re-claimed by the same `INSERT ... ON CONFLICT ... WHERE expires_at < now()`. Cost: no cleanup job; expired rows are overwritten lazily.

### D17. Business rejections are stored against the key; other failures are not
A 422 thrown by the work is stored and committed; 404, 5xx and unknown errors roll back and release the key. The work runs in a savepoint so a rejection after some writes undoes them first. Storing a 5xx would freeze a transient fault for 24 hours. Cost: a rejected key stays rejected until it expires; the caller uses a new key.

### D18. Replays are byte-identical despite `jsonb`
`jsonb` reorders keys, so the first response is read back from the stored row and both it and every replay are sent from that value. Cost: key order follows `jsonb`; clients must not depend on it.

### D19. Wallet creation needs no key
Unique `email` (citext) and `phone` already make a retry safe: a repeat is `409 WALLET_ALREADY_EXISTS`, never a second wallet, and the detail never says which identifier clashed. Cost: a client that lost the 201 cannot look the wallet up without its id; the 409 still confirms an identifier is registered.

## FX

### D23. Rates are refreshed in the background and served from memory
`RateService` keeps the current snapshot in memory; a scheduler refreshes it and every accepted snapshot is stored, so a restart never starts without rates. Requests never wait on a provider, and all rate work happens before any transaction. Cost: rates can be one refresh interval old; overlapping refreshes are shared.

### D24. Every rate pivots through USD
One table of fiat per 1 USD; `rate(from, to) = usd[to] / usd[from]`. Cross rates are derived, so there is no triangular arbitrage (each hop only rounds down). Cost: a better direct quote for one pair is not used.

### D25. Rates are floored to 12 decimals and that exact string is recorded
The recorded rate, the quote and the conversion are the same number, so `floor(source x rate)` is reproducible from the stored row. The system rounds against the customer by at most one unit of the 12th decimal (1500 cNGN is 0.999999 USD, not 1.000000).

### D26. Coins are pegged 1:1 to their fiat, with no spread
The coin rate is the fiat rate and no fee or spread applies. A spread would be a change in `RateService.getRate` only.

### D28. USD totals floor each balance; rates use registry order
`total_usd` converts and floors each balance on its own, sums, then prints rounded down to 2 decimals, so it never overstates. `GET /v1/fx/rates` lists pairs in registry order (cNGN, cGHS, cXAF, USDx, EURx), the same as wallet balances.

### D32. A swap resolves its rate before `BEGIN` and carries a failure into the idempotency boundary
The rate is priced before the transaction opens (no provider work inside one); a failure is captured and rethrown as the first line of the idempotency work. So dust (`AMOUNT_TOO_SMALL`, 422) is stored against the key, an outage (503) releases it, and a replay of an earlier success never needs FX. Cost: every request computes a quote (a cheap in-memory read); a stored dust rejection is pinned to its key for the TTL, like `INSUFFICIENT_FUNDS`.

### D33. A swap is four legs through the FX pool; dust stays in the pool
`user:from -s`, `fx_pool:from +s`, `fx_pool:to -d`, `user:to +d`, with `d = floor(s x rate)`. Each currency balances on its own and the rate links them on the transaction row. The pool keeps the sub-unit remainder, so customers are never overpaid.

### D36. A transfer is one ACID transaction
Both wallets and the ledger live in one database, so the debit, credit, entries, activity rows and idempotency record commit together or not at all: no saga, outbox or worker. A saga with an outbox becomes necessary when a step cannot join the transaction, such as an external payout rail.

### D46. A simulated rate feed instead of an external provider
A real FX API needs a key and this is an assessment project. `SimulatedFxProvider` is a random walk the background job steps every 54 seconds (`FX_REFRESH_INTERVAL_MS`). The HTTP client, retries, breaker, tiers and nock tests were not built: they exist to survive a remote service failing and a local generator has none. A real provider would be a new adapter behind the `FxProvider` port, with that resilience added in `RateService.refresh()`.

### D47. The walk: small steps, medium steps, a band, no state in the provider
Each tick multiplies every non-USD rate by `1 + d`: 85% of the time `d` is within 0.3%, otherwise within 1.5%, clamped to 30% around the static rates, floored to 6 decimals, USD fixed at 1. The provider holds no state: `RateService` passes the newest stored table, so a rejected or failed step is never built on and replicas share one series. Randomness is injected for seeded tests. Config is checked so small <= medium <= max move and medium <= band; narrowing the band below stored rates can make ticks fail validation until the snapshot table is reset.

### D48. Simulated rates were first recorded as `live`
Superseded by D61.

### D49. Validation is a guard
Every table is validated before it is stored or used: five fiats, plain positive decimals within bounds, USD exactly 1, and no move over `FX_MAX_MOVE_PCT` against the previous table (skipped when there is none). A rejected table is not persisted, the previous snapshot stays in force and the reason is `last_error` in readiness, which stays 200.

### D50. Snapshot growth and defaults
One row per tick is about 1,600 a day; there is no retention job. `FX_PROVIDER` defaults to `simulated` (`static` gives fixed rates); `live` is no longer valid.

### D61. `simulated` is a rate source
The simulated feed, its snapshots, quotes and conversions are recorded as `simulated`, so stored rows say what produced the rate (this extends the original `live | cached | static | quote` list and supersedes D48). `live` and `cached` stay allowed for history and a future real provider, but nothing writes them. Migration 0007 relabels the `live` snapshots and quotes; `transactions` is append-only, so earlier transactions keep `live`.

## Quotes

### D51. Quotes are rows consumed inside the idempotency work
`fx_quotes` stores wallet, pair, amounts, the 12-decimal rate and its source, `expires_at` (Clock time plus `FX_QUOTE_TTL_MS`) and `used_at`; it is mutable on purpose. A swap or cross-currency transfer with `quote_id` skips live pricing, locks the quote row, checks it and posts at the stored rate and amounts with `rate_source = quote`. A partial unique index on `transactions(quote_id)` makes the database refuse a second transaction for one quote.

### D52. The idempotency claim comes before the quote check
A retry of a successful quoted swap reaches the replay branch and returns the stored 201 instead of `QUOTE_USED`. Checks run: unknown (404), mismatch, used, expired (422, stored). A 422 rolls back to the savepoint, so a failed swap does not burn the quote.

### D53. Lock order: quote row, then accounts
The quote row is locked first and the user accounts after, in ascending id order. A transaction holds at most one quote lock, so there is no cycle. Two simultaneous uses serialise on the row: one 201, one `QUOTE_USED`.

### D54. Quotes use application time and are not tied to an operation
`expires_at` is written from and compared with the injected Clock (`now >= expires_at` is expired); `created_at` and `used_at` use database time. A quote is bound to wallet, pair and amount, so either a swap or a cross-currency transfer from that wallet can use it. A `quote_id` on a same-currency transfer is a 400. A wrong-wallet quote answers `QUOTE_MISMATCH` and an unknown id `QUOTE_NOT_FOUND`, which reveals whether an id exists (accepted: no authentication).

### D55. What a quote costs the platform
A quote is a free option: the user can execute only if the market moved in their favour, and the platform carries the rate risk for up to the TTL (default 30 s, at most 10 minutes). Nothing limits open quotes and expired rows are never purged. A real platform would add a spread, limits and a cleanup job.

## Reconciliation and history

### D39. Reconciliation detects drift; it never repairs it
It only reads the ledger and writes its own `reconciliation_runs` row; there is no repair path. Silent repair would hide the bug that caused the drift. Cost: a person must act on a finding.

### D40. All checks read one `REPEATABLE READ` snapshot
Balances, entries and transaction checks see one consistent view, so postings in flight cannot produce false drift. An advisory lock allows one run at a time; a second caller is told it was skipped.

### D42. Freezing on drift is optional and touches wallets only
With `RECON_FREEZE_ON_DRIFT=true` (default false) the run freezes wallets with a drifting balance in the same transaction that records the run; drift is logged with ids and deltas, no personal data. Imbalances that cannot be tied to a wallet are reported but freeze nothing. Unfreezing is a manual database action.

### D43. Real reconciliation compares against something outside the ledger
This sandbox checks the ledger against itself, which catches bugs and tampering but not a ledger that is consistently wrong. Production would also compare with bank or custodian statements, partner settlement files and chain balances, matched by reference and raised as breaks for a person to resolve.

### D44. History cursors carry microseconds
`created_at` has microsecond precision but a JavaScript `Date` holds milliseconds, so a cursor built from a `Date` could skip or repeat rows. The cursor carries the database's exact string with the activity id, is opaque base64url, and is decoded strictly (a malformed one is `400 INVALID_CURSOR`). Cost: the cursor is tied to the sort order.

### D45. Admin endpoints are unauthenticated
There is no authentication in this sandbox, so `GET /v1/admin/reconciliation` and `POST .../run` are open and labelled as such. Cost: anyone who can reach the API can trigger a read-only scan, limited only by the advisory lock. A real deployment puts them behind operator authentication.

## Scope

### D60. Load numbers are local, and rate limiting is left out
The load test runs on a laptop against compose and the README labels the numbers indicative. `@nestjs/throttler` was not added: it is a sandbox guard that would also throttle the demo and load test, and it was optional. Nothing limits request rates.

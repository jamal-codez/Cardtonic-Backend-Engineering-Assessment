# Operation Borderless

Multi-currency stablecoin wallet sandbox API (NestJS, PostgreSQL).

Full documentation is written in phase 9.

## Exchange rates are simulated

No external FX provider is used. A background job moves each rate by a small or medium random step
every 54 seconds, inside a band around the static rates (`config/static-rates.json`). Conversions
record the exact rate used. Simulated rates are labelled `live` in stored data and `provider:
simulated` in responses; they are not market data. Set `FX_PROVIDER=static` for fixed rates.

## Quotes

`POST /v1/fx/quotes` with `{ wallet_id, from_currency, to_currency, amount }` locks the current rate
for 30 seconds (`FX_QUOTE_TTL_MS`). Pass the returned `quote_id` to a swap or a cross-currency
transfer from that wallet to execute at the locked rate (`rate_source: quote`). A quote works once,
for the quoted wallet, pair and amount only. Using it again gives `QUOTE_USED`, after expiry
`QUOTE_EXPIRED`, for something else `QUOTE_MISMATCH`. Retrying a swap that succeeded with the same
`Idempotency-Key` returns the original response, not `QUOTE_USED`.

## Admin endpoints (unauthenticated)

`GET /v1/admin/reconciliation` and `POST /v1/admin/reconciliation/run?mode=full|incremental` are
admin endpoints. This sandbox has no authentication, so anyone who can reach the API can call them.
Reconciliation only detects drift; it never changes balances or entries. `yarn reconcile` runs a
full reconciliation from the command line (exit 0 ok, 1 drift, 2 skipped, 3 failed).

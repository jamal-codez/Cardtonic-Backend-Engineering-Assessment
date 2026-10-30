# Operation Borderless

Multi-currency stablecoin wallet sandbox API (NestJS, PostgreSQL).

Full documentation is written in phase 9.

## Exchange rates are simulated

No external FX provider is used. A background job moves each rate by a small or medium random step
every 54 seconds, inside a band around the static rates (`config/static-rates.json`). Conversions
record the exact rate used. Simulated rates are labelled `live` in stored data and `provider:
simulated` in responses; they are not market data. Set `FX_PROVIDER=static` for fixed rates.

## Admin endpoints (unauthenticated)

`GET /v1/admin/reconciliation` and `POST /v1/admin/reconciliation/run?mode=full|incremental` are
admin endpoints. This sandbox has no authentication, so anyone who can reach the API can call them.
Reconciliation only detects drift; it never changes balances or entries. `yarn reconcile` runs a
full reconciliation from the command line (exit 0 ok, 1 drift, 2 skipped, 3 failed).

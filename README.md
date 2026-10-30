# Operation Borderless

Multi-currency stablecoin wallet sandbox API (NestJS, PostgreSQL).

Full documentation is written in phase 9.

## Admin endpoints (unauthenticated)

`GET /v1/admin/reconciliation` and `POST /v1/admin/reconciliation/run?mode=full|incremental` are
admin endpoints. This sandbox has no authentication, so anyone who can reach the API can call them.
Reconciliation only detects drift; it never changes balances or entries. `yarn reconcile` runs a
full reconciliation from the command line (exit 0 ok, 1 drift, 2 skipped, 3 failed).

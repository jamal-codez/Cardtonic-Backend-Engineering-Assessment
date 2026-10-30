#!/bin/sh
set -eu
node dist/db/migrate.js
node dist/db/seed.js
exec node dist/main.js

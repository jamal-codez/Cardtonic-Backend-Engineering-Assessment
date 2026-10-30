#!/bin/sh
# Phase 2 adds migrate and seed before the start.
set -eu
exec node dist/main.js

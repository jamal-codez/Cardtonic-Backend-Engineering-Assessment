#!/usr/bin/env bash
# Proves the project works from a clean checkout with only Docker and Node installed.
#
#   scripts/fresh-clone-check.sh                  clone the repository (committed work only)
#   scripts/fresh-clone-check.sh --working-tree   copy tracked and untracked files that are not
#                                                 git-ignored (use it before committing)
#
# It runs `docker compose down -v`, `docker compose up -d --build`, waits for readiness, runs
# `yarn install --immutable && yarn test`, then `yarn demo`, and tears everything down.
#
# It uses its own compose project name and host ports, so it never touches other containers or
# volumes. Override with FRESH_PROJECT, FRESH_API_PORT and FRESH_POSTGRES_PORT if needed.
set -euo pipefail

MODE="clone"
if [ "${1:-}" = "--working-tree" ]; then MODE="working-tree"; fi

for tool in docker git curl node; do
  command -v "$tool" >/dev/null 2>&1 || { echo "fresh-clone-check: '$tool' is required" >&2; exit 2; }
done

SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK_DIR="$(mktemp -d)"
export COMPOSE_PROJECT_NAME="${FRESH_PROJECT:-borderless-fresh-check}"
case "$COMPOSE_PROJECT_NAME" in
  *fresh*) ;;
  *) echo "FRESH_PROJECT must contain 'fresh': this script runs docker compose down -v" >&2; exit 2 ;;
esac
export API_PORT="${FRESH_API_PORT:-3300}"
export POSTGRES_PORT="${FRESH_POSTGRES_PORT:-5441}"
BASE_URL="http://127.0.0.1:${API_PORT}"
STARTED=0

step() { printf '\n==> %s\n' "$1"; }

cleanup() {
  status=$?
  if [ "$STARTED" = "1" ]; then
    step "Tearing down"
    (cd "$WORK_DIR/repo" && docker compose down -v) || true
  fi
  rm -rf "$WORK_DIR"
  if [ "$status" = "0" ]; then echo "fresh-clone-check: PASSED"; else echo "fresh-clone-check: FAILED"; fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

step "Preparing a clean copy ($MODE)"
if [ "$MODE" = "clone" ]; then
  git clone --quiet "$SOURCE_DIR" "$WORK_DIR/repo"
else
  mkdir -p "$WORK_DIR/repo"
  (cd "$SOURCE_DIR" && git ls-files -z --cached --others --exclude-standard) |
    while IFS= read -r -d '' file; do
      # Deleted-but-tracked files are listed too; skip them.
      [ -e "$SOURCE_DIR/$file" ] || continue
      mkdir -p "$WORK_DIR/repo/$(dirname "$file")"
      cp "$SOURCE_DIR/$file" "$WORK_DIR/repo/$file"
    done
fi
cd "$WORK_DIR/repo"

step "docker compose down -v, then up -d --build (API on :$API_PORT, Postgres on :$POSTGRES_PORT)"
docker compose down -v
STARTED=1
docker compose up -d --build

step "Waiting for readiness"
for attempt in $(seq 1 60); do
  if curl -fsS "$BASE_URL/health/ready" >/dev/null 2>&1; then
    echo "ready after ${attempt} check(s)"
    break
  fi
  if [ "$attempt" = "60" ]; then
    docker compose logs --tail 80 api || true
    echo "the API did not become ready in time" >&2
    exit 1
  fi
  sleep 2
done

step "yarn install --immutable && yarn test"
corepack enable >/dev/null 2>&1 || true
yarn install --immutable
yarn test

step "yarn demo"
BASE_URL="$BASE_URL" yarn demo

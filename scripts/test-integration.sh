#!/usr/bin/env bash
# Runs the real-Postgres finance integration tests against a throwaway database.
# Usage: npm run test:integration   (needs a local Postgres reachable by `psql`)
set -euo pipefail
cd "$(dirname "$0")/.."
DB_NAME="${TEST_DB_NAME:-matchena_integration_test}"
BASE_URL="${TEST_PG_URL:-postgresql://$(whoami)@localhost:5432}"
case "$DB_NAME" in *test*|*tmp*) ;; *) echo "refusing: DB name must contain 'test' or 'tmp'"; exit 1;; esac
psql "$BASE_URL/postgres" -qc "DROP DATABASE IF EXISTS \"$DB_NAME\"" -c "CREATE DATABASE \"$DB_NAME\""
export TEST_DATABASE_URL="$BASE_URL/$DB_NAME?schema=public"
trap 'psql "$BASE_URL/postgres" -qc "DROP DATABASE IF EXISTS \"$DB_NAME\"" >/dev/null' EXIT
DATABASE_URL="$TEST_DATABASE_URL" npx prisma migrate deploy >/dev/null
DATABASE_URL="$TEST_DATABASE_URL" npx jest --config ./test/jest-e2e.json --runInBand --testRegex 'finance\.e2e-spec\.ts$'

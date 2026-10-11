#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
TASK_GUEST_DB_NAME="matchena_guest_test_$(date +%s)_$$"
createdb --host localhost --port 5432 "$TASK_GUEST_DB_NAME"
trap 'dropdb --host localhost --port 5432 "$TASK_GUEST_DB_NAME"' EXIT
export TEST_DATABASE_URL="postgresql://$(whoami)@localhost:5432/$TASK_GUEST_DB_NAME?schema=public"
DATABASE_URL="$TEST_DATABASE_URL" npx prisma migrate deploy
DATABASE_URL="$TEST_DATABASE_URL" npx jest --config ./test/jest-e2e.json --runInBand --testRegex 'guest-social\.e2e-spec\.ts$'

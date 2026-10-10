#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
TASK_DB_NAME="matchena_gaming_test_$(date +%s)_$$"
TASK_DB_BASE="postgresql://$(whoami)@localhost:5432"
createdb "$TASK_DB_NAME"
trap 'dropdb "$TASK_DB_NAME"' EXIT
export TEST_DATABASE_URL="$TASK_DB_BASE/$TASK_DB_NAME?schema=public"
DATABASE_URL="$TEST_DATABASE_URL" npx prisma migrate deploy
DATABASE_URL="$TEST_DATABASE_URL" npx jest --config ./test/jest-e2e.json --runInBand --testRegex 'gaming-(layout|operations|alerts|journey|defaults|setup|audit)\.e2e-spec\.ts$'

#!/bin/zsh
# Rebuilds and (re)starts THIS worktree's API on :3050 against the scratch DB with the camo flags on.
# It reads secrets from the main checkout's .env but forces DATABASE_URL to the scratch DB (never mal3ab_dev).
set -e
cd "$(dirname "$0")/.."
export PATH=$HOME/.nvm/versions/node/v24.22.0/bin:$PATH
# stop only what listens on THIS script's port (:3050); never a developer's own API on :3000
lsof -tiTCP:3050 -sTCP:LISTEN 2>/dev/null | xargs kill 2>/dev/null || true
npm run build >/tmp/camo-api-build.log 2>&1 || { tail -20 /tmp/camo-api-build.log; exit 1; }
set -a; source ../back-end/matchena-api/.env; set +a
export DATABASE_URL="postgresql://hossamelharery@localhost:5432/${CAMO_DB:-camo_scratch_20261022}?schema=public"
export CAMO_DEV_SEEKER_FIRST=${CAMO_DEV_SEEKER_FIRST:-0}
export CAMO_DEV_HIDER_FIRST=${CAMO_DEV_HIDER_FIRST:-0}
export CAMO_DEV_REVEAL=${CAMO_DEV_REVEAL:-0}
export PORT=3050 CAMO_ENABLED=true CAMO_PUBLIC_MATCH_ENABLED=true CAMO_VOICE_ENABLED=true LOBBY_MOVEMENT_ENABLED=true LOBBY_BALL_ENABLED=true
case "$DATABASE_URL" in *mal3ab_dev*|*mal3ab_demo*) echo "refusing: DATABASE_URL points at a real dev DB"; exit 1;; esac
echo "API on :3050 -> $DATABASE_URL"
nohup node --enable-source-maps dist/src/main > /tmp/camo-api.log 2>&1 &

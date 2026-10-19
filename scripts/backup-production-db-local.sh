#!/usr/bin/env bash
# Creates an encrypted PostgreSQL backup on this Mac without storing credentials
# or the encryption passphrase in the repository.
set -euo pipefail

backup_dir="${MATCHENA_BACKUP_DIR:-$HOME/Documents/Matchena Backups}"
database_url="${MATCHENA_DATABASE_URL:-}"

if [[ -z "$database_url" ]]; then
  echo "MATCHENA_DATABASE_URL is required (it is never written to disk by this script)." >&2
  exit 1
fi

pg_dump_bin="${PG_DUMP_BIN:-$(command -v pg_dump || true)}"
if [[ -z "$pg_dump_bin" ]]; then
  echo "pg_dump was not found. Install the PostgreSQL client, then run again." >&2
  exit 1
fi

mkdir -p "$backup_dir"
chmod 700 "$backup_dir"

timestamp="$(date +%Y-%m-%d_%H-%M-%S)"
plain_dump="$(mktemp "${TMPDIR:-/tmp}/matchena-${timestamp}.XXXXXX.dump")"
encrypted_dump="$backup_dir/matchena-postgres-${timestamp}.dump.enc"

cleanup() {
  rm -f "$plain_dump"
}
trap cleanup EXIT

echo "Exporting the database…"
"$pg_dump_bin" --format=custom --no-owner --no-privileges --file="$plain_dump" "$database_url"

echo "Choose a strong backup passphrase. It is not saved anywhere."
openssl enc -aes-256-cbc -salt -pbkdf2 -iter 600000 -in "$plain_dump" -out "$encrypted_dump"
chmod 600 "$encrypted_dump"

echo "Backup created: $encrypted_dump"
echo "Keep the passphrase in a password manager. Test restoration before relying on a backup."

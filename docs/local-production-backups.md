# Local production database backups

This creates an encrypted, restorable PostgreSQL backup on the Mac. It costs nothing and does not put the database URL or backup passphrase in Git, Coolify, or a shell-history file.

## First run

1. In Coolify, open the production API application's **Environment Variables** and copy `DATABASE_URL`.
2. In a Terminal in the API repository, run the following. Paste the connection string only when the terminal asks for it; do not save it in `.env` or a script.

   ```bash
   read -s 'MATCHENA_DATABASE_URL?Production DATABASE_URL: '; export MATCHENA_DATABASE_URL
   ./scripts/backup-production-db-local.sh
   unset MATCHENA_DATABASE_URL
   ```

The encrypted file is saved under `~/Documents/Matchena Backups/`. The script asks for a passphrase and saves neither it nor the unencrypted dump. Keep the passphrase in a password manager.

## Restore drill

Use a new local database or a temporary server database—never overwrite production during a test.

```bash
openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 \
  -in "$HOME/Documents/Matchena Backups/matchena-postgres-YYYY-MM-DD_HH-MM-SS.dump.enc" \
  -out /tmp/matchena-restore.dump
pg_restore --clean --if-exists --no-owner --dbname "postgresql://LOCAL_TEST_CONNECTION" /tmp/matchena-restore.dump
rm -f /tmp/matchena-restore.dump
```

Run a backup weekly and retain at least the latest four. Copy the encrypted files to a second location such as an external drive; keeping the only copy on the same laptop is not disaster recovery.

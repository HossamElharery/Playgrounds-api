# Mal3ab API

Backend for **Mal3ab** — a bilingual (Arabic/English) sports venue booking and social play platform. NestJS 11 + Prisma 6 + PostgreSQL.

For the full architecture, data model, endpoint catalog, and realtime contract, see **[MAL3AB_BACKEND.md](./MAL3AB_BACKEND.md)** — written for any AI assistant, mobile developer, or frontend developer picking this up with zero prior context.

## Quick start

```bash
# 1. Install dependencies
npm install

# 2. Copy the env template and fill in secrets
cp .env.example .env
# Generate JWT/QR secrets with: openssl rand -hex 32

# 3. Create the local database (Postgres must be running)
createdb mal3ab_dev

# 4. Run migrations
npm run prisma:migrate

# 5. Seed reference + demo data (sports, Egypt districts, sample venues/users)
npm run seed

# 6. Start the dev server
npm run start:dev
```

The API listens on `http://localhost:3000/api/v1`. Interactive docs (Swagger) at `http://localhost:3000/api/docs`.

Seeded logins (after `npm run seed`):
- **Admin:** `admin@mal3ab.app` / `Password123!`
- **Owner:** `owner@mal3ab.app` / `Password123!`
- **Players:** phone `+2010000010X` (X = 0-9) — OTP is printed to the server console, never returned in any API response

## Scripts

| Script | Purpose |
|---|---|
| `npm run start:dev` | Dev server with watch mode |
| `npm run build` | Production build (`dist/`) |
| `npm run start:prod` | Run the production build |
| `npm run prisma:migrate` | Apply/create migrations |
| `npm run prisma:studio` | Browse the database visually |
| `npm run seed` | Populate reference + demo data |
| `npm test` | Unit tests |
| `npm run lint` | ESLint |

## Environment

See `.env.example` for the full list. Nothing requires a paid third-party account to run locally:
- **Database:** local Postgres, no extensions beyond `pg_trgm` (auto-enabled by migrations)
- **File storage:** local disk by default (`STORAGE_PROVIDER=local`); flip to `s3` + AWS credentials for production
- **OTP delivery:** logs to the console by default (`OTP_PROVIDER=console`); swap in a real SMS provider later
- **Payments:** mock checkout provider (instant success except cash-at-venue)

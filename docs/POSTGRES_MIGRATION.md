# Postgres swap (LOCAL.md §17)

LOCAL.md §17 declares Postgres as the production DB. The MVP runtime
ships better-sqlite3 for zero-setup local development; this doc lays out
the exact swap.

## What's already done

- **`apps/backend/migrations/postgres.sql`** — the LOCAL.md §7 schema in
  Postgres syntax (TEXT app IDs, JSONB, TIMESTAMPTZ, TEXT[], BOOLEAN, BIGSERIAL).
- **`docker-compose.yml`** — Postgres 16 on port `5433`, auto-loads
  `migrations/postgres.sql` on first boot via the
  `/docker-entrypoint-initdb.d` mechanism.
- **Data layer** — `apps/backend/src/db/repo.ts` is the single chokepoint
  for SQL. Swapping drivers replaces the import in `db/index.ts` plus the
  small set of dialect-specific bits listed below.

## Steps

1. Bring up Postgres.
   ```bash
   docker compose up -d postgres
   docker compose logs -f postgres   # wait for "database system is ready"
   ```

2. Add the `pg` driver.
   ```bash
   pnpm --filter @drill/backend add pg
   pnpm --filter @drill/backend add -D @types/pg
   ```

3. Replace `apps/backend/src/db/index.ts` with a Postgres pool. Sketch:

   ```ts
   import pg from "pg";
   import { config } from "../config.js";

   export const db = new pg.Pool({
     connectionString:
       process.env.DATABASE_URL ??
       "postgres://drill:drill@localhost:5433/drill_coach",
     max: 10,
   });
   ```

4. Convert `apps/backend/src/db/repo.ts` calls. The current code uses
   `better-sqlite3`'s synchronous API (`db.prepare(...).run()/get()/all()`);
   switch to `await db.query(text, params)` and adjust the call sites to
   async. The dialect deltas:

   | SQLite                              | Postgres                                 |
   | ----------------------------------- | ---------------------------------------- |
   | `datetime('now')`                   | `NOW()`                                  |
   | `datetime('now', '+1 day')`         | `NOW() + interval '1 day'`               |
   | `INSERT OR IGNORE`                  | `INSERT ... ON CONFLICT DO NOTHING`      |
   | `?` placeholders                    | `$1`, `$2`, ... placeholders             |
  | `TEXT` ids                          | `TEXT` ids (keeps slug drill IDs + demo users compatible) |
  | `INTEGER` (booleans as 0/1)         | `BOOLEAN` (true/false)                   |
   | `TEXT` storing JSON strings         | `JSONB` (no `JSON.parse` needed)         |
   | `RETURNING ...` (already supported) | `RETURNING ...` (same)                   |
   | `db.transaction(fn)`                | `await pool.connect()` + `BEGIN/COMMIT`  |

5. Delete `runMigrations()`'s embedded SQL or replace it with `pg`'s
   `pool.query(fs.readFileSync('migrations/postgres.sql'))` so dev parity
   matches the docker entrypoint.

6. Re-run the seed:
   ```bash
   DATABASE_URL=postgres://drill:drill@localhost:5433/drill_coach \
     pnpm --filter @drill/backend seed
   ```

7. Re-run the tests and smokes. The route tests already abstract
   `DATABASE_PATH`; switch them to `DATABASE_URL` and they should pass
   without further changes once `repo.ts` is async.

## Why we shipped SQLite first

LOCAL.md §15 says MVP 1 should hit the **drill-loop quality bar** before
introducing infra ceremony. SQLite gave us:

- Zero-setup local dev (no docker, no auth).
- Trivial test isolation (`process.env.DATABASE_PATH = tmp.db`).
- Identical query semantics for everything we actually use (composite
  primary keys, indexes, `RETURNING`, `ON CONFLICT DO UPDATE`).

The Postgres swap is straightforward because we kept SQL access behind
`repo.ts` from day one. Schema and indexes match LOCAL.md §7 in both
worlds.

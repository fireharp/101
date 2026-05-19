# Contributing

Onboarding for anyone (including future-you) opening this repo fresh. The
README is the user-facing surface; this doc is the engineering surface.

## What this is

A browser voice-drill app that trains fast staff/system-design interview
reflexes. The full design spec is in `LOCAL.md` (gitignored — get it from
the original assignment). Section numbers below reference it.

Two apps, one pnpm workspace:

```
apps/
  backend/    Node 22 + Express + TypeScript + better-sqlite3
  frontend/   React 19 + Vite + TypeScript
```

See `README.md` → "LOCAL.md spec coverage" for the section-by-section map.

## Dev loop

```bash
pnpm install          # one time
cp apps/backend/.env.example .env   # or place a single .env at the root
# put OPENAI_API_KEY in .env
pnpm dev              # backend on :4000, frontend on :5173
```

When in doubt:

```bash
pnpm check            # build + tests + offline smokes — same as CI
```

## Architecture cheat sheet

```
React App (apps/frontend/src/App.tsx)
  └─ useRealtime (apps/frontend/src/useRealtime.ts)
       └─ WebRTC ↔ OpenAI Realtime (LOCAL.md §3 Option A)

Express API (apps/backend/src/routes/index.ts)
  ├─ /api/health, /api/stats, /api/sessions, /api/progress[/drills]
  ├─ /api/drill-sessions, /api/drill-attempts, /api/realtime/tool-call
  ├─ /api/drills (browse / drafts / activate / patch / test-grade / import-export)
  └─ /api/cards/{due, :id/review, export.csv}

repo.ts (single SQL chokepoint)
  ├─ drills    rotation pool, drafts, stats, patch, set-active
  ├─ sessions  create / end / recent
  ├─ attempts  create-pending, transcript, grade, prior-for-drill, performance-by-drill
  ├─ events    session_events audit log
  ├─ cards     generated_cards SM-2-lite
  ├─ skillState user_skill_state weakness/SR
  └─ usageEvents token cost tracking (in-flight)

engines/
  ├─ rotation.ts  LOCAL.md §8 weighted selection + mock_interview variant
  └─ grading.ts   LOCAL.md §10 rubric grading (LLM + offline)
```

## The test pyramid

| Layer | Command | When it runs |
| --- | --- | --- |
| YAML drill linter | `pnpm verify:drills` | Every PR via CI. Validates `seeds/drills/*.yaml` against the seed schema; flags duplicate ids. |
| Backend unit + route | `pnpm -r test` | Every PR via CI. `node:test` + Express on an ephemeral port. |
| REST drill loop | `pnpm smoke:drill-loop` | Every PR via CI. Boots its own backend. Offline grader. |
| Browser drill loop | `pnpm smoke:browser` | Every PR via CI. Playwright, no mic. Asserts grade panel + history + events timeline. |
| Realtime WebRTC | `pnpm smoke:realtime` | Local only — needs `OPENAI_API_KEY`. |
| Realtime multi-turn | `pnpm smoke:realtime:multi` | Local only — proves ≥ 2 distinct tool calls. |
| Realtime autonomy | `pnpm smoke:realtime:loop` | Local only — proves ≥ 3 calls incl. `get_next_drill`. |
| Realtime stop | `pnpm smoke:realtime:end` | Local only — proves `end_session_summary` after "Stop". |

CI workflow lives at `.github/workflows/ci.yml` and runs the offline four.

## Recipes

### Add a new drill

The fastest path is Layer 1 (YAML seed):

1. Pick or create a topic file under `apps/backend/seeds/drills/<topic>.yaml`.
2. Append a drill matching the LOCAL.md §16 schema (`id`, `topic`,
   `subtopic`, `difficulty` 1-5, `trap_type`, `question_text`,
   `expected_answer`, `rubric`, `canonical_short_answer`, optional
   `canonical_deep_answer`, `tags`, `is_active`).
3. Validate before committing: `pnpm verify:drills` — exits non-zero on
   any malformed drill or duplicate id, with file + path + zod message.
4. Restart the backend, or `pnpm --filter @drill/backend seed`.
5. `pnpm smoke:browser` should still pass — your drill might or might not
   be picked, but rotation continues.

`pnpm check` runs `verify:drills` first so CI catches bad YAML before
booting the server (otherwise the seed loader just logs a `console.warn`
and skips).

For Layer 2 templates: edit `apps/backend/seeds/templates/*.yaml` and run
`pnpm --filter @drill/backend seed:templates`. For Layer 3 LLM drafts:
`pnpm --filter @drill/backend gen:drills -- --topic X --count N`. Drafts
are `is_active=false`; review and activate them via the admin UI's
**Show drafts** panel.

### Edit a rubric

In the running UI: **Browse drills** → expand a drill → **Edit rubric**.
Saves via `PATCH /api/drills/:id`. Validates with the same Zod schema as
the YAML seed loader.

### Export / re-seed the bank

```bash
curl -sS http://localhost:4000/api/drills/export.yaml > seeds-snapshot.yaml
# edit … then import:
curl -sS -X POST http://localhost:4000/api/drills/import \
  -H 'content-type: application/x-yaml' \
  --data-binary @seeds-snapshot.yaml | jq
```

Same YAML schema as `seeds/drills/*.yaml`, so you can commit
`seeds-snapshot.yaml` back to the seed dir.

### Add a route

1. Add the handler in `apps/backend/src/routes/index.ts`. Use the
   `userIdFromRequest(req)` helper for owner-scoping (it reads the
   `x-user-id` header, defaulting to `demo-user`).
2. Add a route test in `apps/backend/src/routes/index.test.ts`. The test
   harness spins up `createApp()` on `app.listen(0)` so port collisions
   never happen; use the local `http()` helper.
3. Document the endpoint in the README API table.

### Add a smoke

Any new UI affordance gets a `data-testid` attribute and a small assertion
in `scripts/drill-loop-browser-smoke.mjs`. Use `page.waitForFunction` over
`sleep` so the smoke survives async effects.

## Voice agent — keep it loopy

The hard non-negotiable from LOCAL.md §18: the **backend owns the
curriculum**. The Realtime model is the voice surface. Specifically:

- Tools defined in `apps/backend/src/services/realtime.ts:DRILL_COACH_TOOLS`
  are attached to every minted client secret. They merge with whatever
  prompt id is configured server-side (`OPENAI_REALTIME_PROMPT_ID`).
- Dispatch happens in `apps/frontend/src/useRealtime.ts:handleFunctionCallEvent`
  → `runToolCall` → `POST /api/realtime/tool-call`.
- After `grade_attempt`, the client injects a faux-user "Next drill,
  please" so the agent calls `get_next_drill` even when the Playground
  prompt is weak on autonomy. Suppressible via
  `window.__drillSuppressAutoNextDrill` (used by the end-session smoke
  so its "Stop" message wins).

If you update `seeds/realtime-prompt.md`, paste it into the Playground
prompt referenced by `OPENAI_REALTIME_PROMPT_ID` and bump
`OPENAI_REALTIME_PROMPT_VERSION` in `.env`. The realtime token mint will
pick up the new version on the next request.

## Postgres

SQLite is the MVP. Schema is portable; the swap path is in
`docs/POSTGRES_MIGRATION.md` with a docker-compose for local Postgres and
`apps/backend/migrations/postgres.sql` as the source of truth for the
Postgres-flavored schema.

## What is NOT in scope (per LOCAL.md §15)

- Payments, mobile app, Anki sync, calendar scheduling, multi-user admin.
- The MVP runs as one demo user via `x-user-id` header (default
  `demo-user`). Real auth slots in at `userIdFromRequest`.

## Things to remember

- Default to the offline grader (`USE_OFFLINE_GRADER=1`) for tests and
  smokes so you don't burn OpenAI tokens.
- The audit log (`session_events`) is the source of truth for "what
  happened in this session" — prefer querying it over recomputing from
  attempts joins.
- Add `data-testid` to anything that lives in the UI for more than a few
  rounds. It's the only way the browser smoke can keep up with the
  growing surface.
- Tests can rely on the seed fixtures (`fx_db_001`, `fx_sd_001`,
  `fx_draft_001`) inserted in `routes/index.test.ts` — but state changes
  across tests (e.g. a draft activated by an earlier test stays activated
  for later ones). Make new tests tolerant.

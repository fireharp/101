# Changelog

What's shipped, oriented by LOCAL.md milestone rather than commit. For
the day-to-day signal use `git log`; this is the high-altitude map.

Format: each phase groups related work. Newer phases at the top.

## Reliability infrastructure (post-MVP)

Tooling that turns "is this still working?" from a 20-minute manual
audit into one command.

- **ISO 8601 timestamps end-to-end** — SQLite schema defaults switched
  from `datetime('now')` (naive `YYYY-MM-DD HH:MM:SS`) to
  `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')` (ISO 8601 with `Z`). All
  programmatic timestamps (`sessions.end`, `skillState.upsertAfterAttempt`,
  card scheduling) use the same format. `sessions.create` and
  `attempts.createPending` now use `RETURNING` so the in-memory object
  matches the persisted row exactly. A one-shot backfill in
  `runMigrations` normalises any pre-existing naive rows (idempotent).
  Fixes a latent UI bug where `Date.parse(stored)` interpreted naive
  timestamps as local time instead of UTC. Regression-locked by a route
  test that asserts every API-emitted timestamp matches the ISO regex.

- **`pnpm dev:doctor`** — environment diagnostic: Node, pnpm, env file,
  `OPENAI_API_KEY`, `better-sqlite3` native binding (the most common
  fresh-clone breakage), DB writability, port availability, Playwright
  chromium presence, drill seed dir. 12 checks, each with a fix hint.
- **`pnpm dev:reset`** — wipes the local SQLite + `-wal` / `-shm` /
  `-journal` siblings and re-seeds from YAML. Refuses if a dev backend
  is listening on `PORT`.
- **`pnpm verify:drills`** — Zod-validates every seed YAML against the
  shared schema, flags duplicate ids across files, warns on quality
  smells (empty rubric, tiny canonical answer, terse question). Strict
  mode (`-- --strict`) turns warnings into errors.
- **`pnpm smoke:all`** — composite gate. Runs 10 layers
  (dev:doctor → verify:drills --strict → build → tests → REST smoke →
  browser smoke → 4 realtime smokes) with a pass/fail table and timing.
  `--offline-only` skips the realtime layer for fast iteration.
- **`pnpm check`** — same offline subset, used by CI.
- **Realtime smoke tiers** — `smoke:realtime` (≥ 1 tool call) ·
  `smoke:realtime:multi` (≥ 2 distinct) · `smoke:realtime:loop` (≥ 3
  including `get_next_drill` — proves autonomy) ·
  `smoke:realtime:end` (Stop message → `end_session_summary`, with
  response-done race fix).
- **Tool-call dispatch coverage** — every LOCAL.md §6 tool now has a
  route test, including the two the realtime smokes don't exercise
  (`save_generated_cards` malformed-input filter,
  `get_user_skill_summary` against a freshly graded user).
- **`db/seed.test.ts`** — unit tests for `importDrillsFromYaml`
  covering the four explicit return paths (parse failure, empty
  document, single-object wrap, mixed valid+invalid partial success).
  Pushed import edge-case coverage down from HTTP to direct unit.
- **`apps/frontend/src/api.test.ts`** — first frontend test file.
  Covers `ApiError` extraction of OpenAI metadata (request id, status,
  retryable, retry-after) and the requestId fallback chain
  (`opts.requestId` → `payload.request_id` → `null`). Runs under
  `tsx --test` via `pnpm -r test` so it's part of every CI run. Test
  files are excluded from `tsc -b` to keep React build free of Node
  types.
- **CI** — `.github/workflows/ci.yml` runs `smoke:all --offline-only`
  on every PR; `.github/workflows/realtime-smoke.yml` runs the
  realtime tiers daily via cron + on push to voice-related files.
  Gracefully skips when `OPENAI_API_KEY` secret is absent.

## Documentation

- **`README.md`** — user-facing, LOCAL.md spec-coverage table, API
  table, dev commands, audio troubleshooting, keyboard shortcuts.
- **`CONTRIBUTING.md`** — engineering-facing: architecture cheat sheet,
  test pyramid, recipes (add a drill, edit a rubric, add a route, add
  a smoke), voice-agent autonomy notes.
- **`docs/POSTGRES_MIGRATION.md`** — exact swap path for LOCAL.md §17
  Postgres (docker-compose + `apps/backend/migrations/postgres.sql`).
- **`apps/backend/seeds/realtime-prompt.md`** — the drill-coach agent
  prompt, paste source for the Playground prompt referenced by
  `OPENAI_REALTIME_PROMPT_ID`.

## Voice UX hardening

LOCAL.md §3 / §5 / §11 — "agent asks the question aloud" + "fast
back-and-forth" — backed up with visible UI affordances.

- **Voice-first start** — one click chains `startSession → nextDrill →
  realtime.start`. No separate "Start voice" step.
- **Live agent transcript** — `response.output_audio_transcript.delta`
  rendered above the answer box, so a muted browser still shows you
  exactly what the coach is saying.
- **Voice-state badge** — `🔊 Coach speaking` vs `🎤 Listening`,
  derived from audio-buffer events.
- **Mic meter** — 5-bar VU pulled from a Web Audio AnalyserNode on the
  local mic track, sampled ~10 Hz.
- **Voice error banner** — replaces the buried `<p class="error">` with
  a real banner including a short troubleshooting hint (mic perms /
  key / HTTPS).
- **Pressure mode toggle** — header switch that appends an explicit
  "interrupt rambling, snap 'Default answer now'" clause to every
  pushDrill instruction.
- **Tool-protocol autonomy** — frontend tracks the GA Realtime split of
  function-call events (`response.output_item.added` carries the name;
  `response.function_call_arguments.done` carries the args), dispatches
  via `/api/realtime/tool-call`, and a backstop after `grade_attempt`
  ties a "Next drill, please" nudge to the verdict's `response.done`
  to keep the loop infinite without cutting off in-flight responses.

## Admin surface (LOCAL.md §13)

- **Admin audit trail** — drill imports, draft activate / deactivate /
  discard, and rubric edits write to `session_events` under sentinel
  `__admin__` and surface via `GET /api/admin/events`. The PATCH
  rubric handler records which fields changed. Every event payload
  carries the `actor` (`x-user-id`) so the audit answers *who* did it,
  forward-compatible with the LOCAL.md §15 deferred multi-user admin
  scope (no schema change — payload is JSON). Supports `?type=` (CSV
  of admin event types, invalid types return 400 with the allow-list),
  `?since=` (ISO 8601, normalised via SQLite `datetime()` so the
  comparison crosses the T-vs-space format gap), `?actor=` (exact
  match on `payload.actor` via `json_extract`; pre-attribution rows
  are correctly excluded since `json_extract` returns NULL), and
  `?limit=` (1–500).
- **Drill browse** — every loaded drill, topic filter, expandable
  rubric, "Edit rubric" inline form, "Test grade" dry-run widget.
- **Drafts panel** — Layer-3 LLM-generated drills (`is_active=false`)
  with **Activate** / **Discard** actions. Activation flips them into
  the rotation pool.
- **Drill bank stats strip** — active/draft counts, top topics, mini
  difficulty bar chart.
- **YAML import / export** — round-trips the bank through
  `/api/drills/export.yaml` and `POST /api/drills/import`, both using
  the same Zod schema as the seed loader. Edit in any tool, push back.
- **Session history panel** — list of past sessions with rollup stats
  (drills_attempted, drills_graded, avg_score, duration). Click for
  summary; click Resume on an open session to continue mid-flight.
- **Session audit timeline** — `session_events` rendered with `+mm:ss`
  per row; shows `session_created → drill_picked → grade_completed → …`.
- **Trouble drills** — bottom-3 by avg score with ≥ 2 attempts, with
  "last better than avg" improvement indicator.
- **Per-attempt drill-down** — click any attempt in the session summary
  to see the transcript, missed points, and ideal answer.

## LOCAL.md §15 MVP 3 — adaptive depth

- **Spaced repetition** — SM-2-lite for `generated_cards` (knew it →
  ease grows + interval extends; forgot → ease shrinks + interval = 0).
- **Per-topic skill graph** — horizontal bar chart, color-coded
  (green ≤ 40 %, amber 40–70 %, red ≥ 70 %).
- **Mock interview mode** — separate rotation formula
  (`0.40 * novelty + 0.20 * topicBalance + 0.20 * difficulty + …`)
  with difficulty floor ≥ 3 and "drills you haven't seen" preference.
  UI shows "Drill N of 7" counter.
- **Compare attempts** — drill panel shows prior attempt scores as
  chips; trouble-drills view shows last-vs-avg delta.
- **Retry this drill** — bypasses rotation to immediately re-attempt a
  failed drill while the rubric is fresh. Audit log records
  `retry: true`.

## LOCAL.md §15 MVP 2 — quality loop

- **Card review** — Reveal → Knew it / Forgot UI per card; due-count
  in the header.
- **Anki CSV export** — `GET /api/cards/export.csv`, RFC-4180-escaped.
- **Weak topic dashboard** — skill graph (see MVP 3).
- **Layer-2 template generator** — `pnpm seed:templates` interpolates
  `{vars}` into a template + variants spec to upsert variant drills.
- **Layer-3 LLM drafts** — `pnpm gen:drills -- --topic X --count N`
  asks `OPENAI_GRADING_MODEL` for drill drafts, validates with the
  seed schema, stores as `is_active=false`.
- **Admin rubric editor** — see "Admin surface" above.

## LOCAL.md §15 MVP 1 — usable voice drill

- **WebRTC connection (LOCAL.md §3 Option A)** — backend mints
  ephemeral `client_secret`; browser does the SDP exchange directly
  with OpenAI. API key never leaves the backend.
- **Rotation engine (LOCAL.md §8)** — `0.35 * due + 0.25 * weakness +
  0.15 * novelty + 0.10 * difficultyFit + 0.10 * topicBalance + 0.05 *
  trapDiversity − 0.50 * recentRepeatPenalty − 0.30 *
  exactRepeatPenalty`, weighted random over top-5.
- **Rubric-first grading (LOCAL.md §10)** — `0.65 * must_have_coverage
  + 0.20 * answer_clarity + 0.10 * tradeoff_coverage + 0.05 *
  speed_score − red_flag_penalty`. LLM path + deterministic offline
  fallback.
- **Seed drill bank** — 51 hand-written canonical drills across 17
  topics (database, system_design, concurrency, distributed,
  messaging, caching, networking, security, data_modeling,
  observability, http, search, time_series, kubernetes, testing,
  performance, api_design). All pass `verify:drills --strict`.
- **Tool protocol (LOCAL.md §6)** — six tools attached to every minted
  realtime session: `get_next_drill`, `submit_answer_transcript`,
  `grade_attempt`, `save_generated_cards`, `get_user_skill_summary`,
  `end_session_summary`. Dispatched via `/api/realtime/tool-call`.
- **Audit log** — every meaningful transition (session_created →
  drill_picked → transcript_submitted → grade_completed → session_ended,
  plus admin events) lands in `session_events`.
- **Data model** — full LOCAL.md §7 schema in SQLite with WAL mode;
  Postgres-flavored mirror at `migrations/postgres.sql`.

## Scope explicitly deferred

Per LOCAL.md §15 "Skip initially": payments, mobile app, Anki sync,
calendar scheduling, multi-user admin. MVP runs as a single demo user
via `x-user-id` header (default `demo-user`); real auth slots in at
`userIdFromRequest` in `routes/index.ts`.

# GPT Realtime Interview Drill Coach

Browser-based voice drill app that trains fast staff/system-design interview
reflexes. Implementation of the spec in `LOCAL.md` (gitignored).

The voice agent runs on OpenAI GPT Realtime over WebRTC. The backend owns the
curriculum, rotation, attempts, grading, and weakness state — the model is the
voice/interview surface, not the brain (LOCAL.md §18).

## LOCAL.md spec coverage

| LOCAL.md section | Status |
| --- | --- |
| §1 Goal · §2 Architecture | ✓ (SQLite swap for Postgres in MVP — schema is portable) |
| §3 Realtime WebRTC (Option A ephemeral token) | ✓ |
| §4 Session config (gpt-realtime-2, reasoning, voice, tools, prompt id) | ✓ |
| §5 Core product flow | ✓ |
| §6 Tool/function interface (`get_next_drill`, `submit_answer_transcript`, `grade_attempt`, `save_generated_cards`, `get_user_skill_summary`, `end_session_summary`) | ✓ all 6 wired + dispatched + smoke-verified |
| §7 Data model | ✓ |
| §8 Rotation engine | ✓ with separate `mock_interview` formula |
| §9 Question generation (Layer 1 YAML, Layer 2 templates, Layer 3 LLM drafts + activation flow) | ✓ |
| §10 Grading (rubric-first JSON, LLM + offline) | ✓ |
| §11 Voice session behavior | ✓ |
| §12 Backend endpoints | ✓ (see API table) |
| §13 Frontend screens (MVP + admin: drill browse, rubric editor, test-grade) | ✓ |
| §14 Prompt skeleton | ✓ (`seeds/realtime-prompt.md`) |
| §15 MVP 1 (50–100 drills, rotation, transcripts, grading, history) | ✓ 55 active drills, 17 topics |
| §15 MVP 2 (cards, weak dashboard, templates, Anki CSV, rubric editor) | ✓ |
| §15 MVP 3 (spaced repetition, skill graph, mock interview, pressure mode, compare attempts) | ✓ |
| §16 Seed format · §17 Engineering decisions · §18 Non-negotiable | ✓ (autonomy verified by `smoke:realtime:loop`) |

**Explicitly out of MVP scope** per LOCAL.md §15: payments, mobile app, Anki
sync, calendar scheduling, multi-user admin. Documented choice: SQLite
instead of Postgres for MVP — schema is portable, migration file is the
swap point. See [`docs/POSTGRES_MIGRATION.md`](docs/POSTGRES_MIGRATION.md)
for the exact swap path (docker-compose.yml + `migrations/postgres.sql`).

## Layout

```
apps/
  backend/          Express + TypeScript + better-sqlite3
    src/
      server.ts             entry
      config.ts             env + paths
      db/
        migrations.ts       SQLite schema (mirrors LOCAL.md §7)
        repo.ts             drills, attempts, skill state, cards
        seed.ts             YAML → DB loader
      engines/
        rotation.ts         LOCAL.md §8 scoring + weighted random
        grading.ts          LOCAL.md §10 rubric grading (LLM or offline)
      services/
        realtime.ts         mints OpenAI Realtime ephemeral client secrets
        llm.ts              OpenAI SDK wrapper
      routes/index.ts       REST API (LOCAL.md §12)
    seeds/drills/*.yaml     canonical drill bank (LOCAL.md §16 format)
  frontend/         React + Vite + TypeScript
    src/
      App.tsx               mode picker, drill UI, transcript, grade panel
      useRealtime.ts        WebRTC connection (LOCAL.md §3 Option A)
      api.ts                fetch wrapper for /api/*
```

## Setup

Requires Node 22+, pnpm 10+, and an OpenAI API key with Realtime access.

```bash
pnpm install
cp apps/backend/.env.example .env   # or place .env at the repo root
# edit .env: set OPENAI_API_KEY
pnpm dev                            # starts backend (4000) + frontend (5173)
```

Open http://localhost:5173.

Single commands:

```bash
pnpm dev:backend   # tsx watch on src/server.ts
pnpm dev:frontend  # vite
pnpm --filter @drill/backend seed   # re-seed drills from YAML
```

### Environment variables

| Variable | Default | Notes |
| --- | --- | --- |
| `PORT` | `4000` | backend port |
| `DATABASE_PATH` | `apps/backend/data/drill.db` | SQLite file |
| `OPENAI_API_KEY` | — | required for realtime + LLM grading |
| `OPENAI_REALTIME_MODEL` | `gpt-realtime-2` | LOCAL.md §17 default |
| `OPENAI_REALTIME_TRANSCRIPTION_MODEL` | `gpt-4o-mini-transcribe` | ASR model for user audio transcript events |
| `OPENAI_REALTIME_TRANSCRIPTION_LANGUAGE` | — | optional language hint, e.g. `en` |
| `OPENAI_GRADING_MODEL` | `gpt-4.1-mini` | text grading after attempt |
| `REALTIME_VOICE` | `marin` | voice id |
| `FRONTEND_ORIGIN` | `http://localhost:5173` | CORS allowlist |
| `USE_OFFLINE_GRADER` | `0` | `1` → deterministic keyword grader (no API call) |

## How it works

### Realtime connection (LOCAL.md §3 Option A)

1. The browser asks the backend for an ephemeral token.
2. The backend calls `POST https://api.openai.com/v1/realtime/client_secrets`
   with the drill-coach system instructions, voice, and reasoning effort.
3. The browser builds an `RTCPeerConnection`, adds microphone audio, opens a
   data channel, and posts its SDP offer directly to
   `POST /v1/realtime/calls?model=...` with the ephemeral token. The OpenAI
   API key never leaves the backend.
4. Audio streams over WebRTC; the model's instructions force the strict
   interview-drill style (LOCAL.md §11, §14).

### Drill loop

1. `POST /api/drill-sessions` → session id.
2. `POST /api/drill-sessions/:id/next` runs the rotation engine and returns a
   drill plus a pre-created `attempt_id`.
3. While voice is live the frontend pushes the drill text into the agent's
   conversation, and the agent asks it aloud.
4. The user speaks; transcription comes back over the data channel.
5. On Submit, the frontend `POST`s the transcript + duration to
   `POST /api/drill-attempts/:id/grade`. The grader runs rubric-first
   scoring, persists the attempt, updates `user_skill_state`, and inserts
   `generated_cards`.

### Rotation engine (LOCAL.md §8)

`apps/backend/src/engines/rotation.ts` implements the full weighted score:

```
0.35 * due
 + 0.25 * weakness
 + 0.15 * novelty
 + 0.10 * difficultyFit
 + 0.10 * topicBalance
 + 0.05 * trapDiversity
 − 0.50 * recentRepeatPenalty
 − 0.30 * exactRepeatPenalty
```

Top 5 candidates are weighted-random-picked so the app is not predictable.

`mock_interview` mode swaps the formula to prefer variety and high
difficulty over due/weakness:

```
0.40 * novelty + 0.20 * topicBalance + 0.20 * difficulty
+ 0.10 * weakness + 0.05 * due + 0.05 * trapDiversity
- 0.60 * recentRepeatPenalty - 0.40 * exactRepeatPenalty
```

and also pre-filters the pool to difficulty ≥ 3 plus drills the user hasn't
attempted recently, so a "mock interview" session feels different from a
study session.

### Grading (LOCAL.md §10)

`apps/backend/src/engines/grading.ts` has two graders:

* **LLM grader (default)** — calls `OPENAI_GRADING_MODEL` with the rubric and
  transcript and parses JSON back into the score breakdown.
* **Offline grader** — deterministic keyword matching for tests / no-API
  environments. Triggered by `USE_OFFLINE_GRADER=1` or absence of
  `OPENAI_API_KEY`.

Final score formula:

```
0.65 * must_have_coverage
+ 0.20 * answer_clarity
+ 0.10 * tradeoff_coverage
+ 0.05 * speed_score
− red_flag_penalty
```

Verdict: `>= 0.80 pass`, `0.60–0.79 borderline`, `< 0.60 fail`.

## API

| Method | Path | Purpose |
| --- | --- | --- |
| `GET`  | `/api/health` | drill count + OpenAI configured flag |
| `POST` | `/api/realtime/token` | mint ephemeral Realtime client secret |
| `POST` | `/api/drill-sessions` | start a drill session |
| `POST` | `/api/drill-sessions/:id/next` | pick next drill via rotation |
| `POST` | `/api/drill-attempts/:id/transcript` | save transcript + duration |
| `POST` | `/api/drill-attempts/:id/grade` | grade an attempt (LLM or offline) |
| `GET`  | `/api/cards/due` | due review cards + total/due stats |
| `POST` | `/api/cards/:id/review` | record SM-2-lite review (`quality` 0/1) |
| `GET`  | `/api/cards/export.csv` | Anki-importable CSV (`front,back,tags`) |
| `GET`  | `/api/progress` | per-topic weakness state |
| `GET`  | `/api/drills` | drill bank browse (active only) |
| `GET`  | `/api/drills/drafts` | Layer-3 LLM drafts (is_active=false) |
| `POST` | `/api/drills/:id/activate` | promote a draft into the rotation pool |
| `PATCH` | `/api/drills/:id` | edit rubric / canonical answer / difficulty / question text |
| `POST` | `/api/drills/:id/test-grade` | dry-run grader against a sample answer (no persist) |
| `DELETE` | `/api/drills/:id` | delete a draft (active drills are protected) |
| `POST` | `/api/realtime/tool-call` | dispatch for the voice agent's tool calls |
| `GET`  | `/api/drill-sessions/:id/summary` | per-session stats (attempts, scores, topics) |
| `POST` | `/api/drill-sessions/:id/end` | mark ended + return summary |

## Seed drills

YAML files in `apps/backend/seeds/drills/` are loaded on every server start
(`drill_items.upsert` so edits are picked up). Schema follows LOCAL.md §16.

To add a drill: create or edit a YAML file, run `pnpm --filter @drill/backend seed`,
or just restart the backend.

### Layer-2 templates (LOCAL.md §9)

Templates live in `apps/backend/seeds/templates/*.yaml`. Each declares a
`template_text`, a `rubric_template`, a `canonical_answer_template`, and a
list of `variants` with named `vars`. The expander interpolates the variables
into every field and upserts concrete `drill_items` rows.

```bash
pnpm --filter @drill/backend seed:templates
```

One composite-index template currently expands to 4 variants
(orders / events / messages / invoices), all tagged with `tmpl:<id>` so
template-derived drills are filterable.

### Layer-3 LLM-generated drafts (LOCAL.md §9 Layer 3)

```bash
pnpm --filter @drill/backend gen:drills -- \
  --topic caching --subtopic eviction --count 3 --difficulty 3
```

Inserts drills as `is_active=false` drafts so the rotation engine never
serves them until a human flips the bit. Tagged with `gen:llm` for filtering.
Uses `OPENAI_GRADING_MODEL` (default `gpt-4.1-mini`).

Review and activate drafts from the UI: click **Show drafts** in the header
to see every `is_active=false` drill with rubric preview, then **Activate**
to promote into the rotation pool or **Discard** to delete.

### Admin: rubric editor + dry-run grader (LOCAL.md §13)

In the drill browse panel, expand any drill to see its rubric. Two admin
surfaces are wired:

* **Edit rubric** — opens textareas for must-have / nice-to-have / red flags
  / canonical short answer plus a difficulty selector. Saving issues
  `PATCH /api/drills/:id`, validates with the same Zod schema as YAML
  seeds, and refreshes the browse list.
* **Test grade** — paste a sample answer, run the grader against the
  current rubric, see score + verdict + missed-points count, **without**
  writing an attempt or touching skill state. Great for tuning rubrics on
  newly activated Layer-3 drafts.

### Pressure mode (LOCAL.md §15 MVP 3)

Header **Pressure ON/off** toggle. When on, every drill push appends an
explicit "interrupt rambling after ~10s; snap 'Default answer now.'; force
at least one pressure follow-up" clause to the agent's per-drill
instruction. Lets the user dial the intensity from study-buddy to
drill-instructor without re-minting the realtime session.

## What is *not* in the MVP

Mapped to LOCAL.md §15:

* **Postgres** — MVP uses SQLite. Schema is portable; the migration file is the
  obvious place to swap when you need multi-writer or hosted infra.
* **Card-review UI** for the spaced-repetition slots already in the schema.
* **Layer-2 template generator** (`drill_templates`) — schema exists,
  no generator yet.
* **Admin/content editor**, **payments**, **Anki sync**, **per-user auth** —
  not in MVP.

### Voice-agent tool protocol (LOCAL.md §6) — wired

The Realtime agent has six backend tools attached to the session config:
`get_next_drill`, `submit_answer_transcript`, `grade_attempt`,
`save_generated_cards`, `get_user_skill_summary`, `end_session_summary`.

Tool calls flow over the data channel and are dispatched via a single
backend endpoint `POST /api/realtime/tool-call`. The frontend hook
(`useRealtime`) tracks (item_id → name) pairs across
`response.output_item.added` and `response.function_call_arguments.done`,
runs the registered handler, and sends back
`conversation.item.create` with `function_call_output` plus
`response.create`.

App.tsx mirrors agent-driven `get_next_drill` and `grade_attempt` results
into local state so the UI follows the agent.

## Smoke test (CLI)

```bash
# health
curl -s localhost:4000/api/health | jq

# start session, pick a drill, grade an answer
SID=$(curl -s -X POST localhost:4000/api/drill-sessions \
  -H 'content-type: application/json' \
  -d '{"mode":"db_indexes"}' | jq -r .session.id)
ATT=$(curl -s -X POST localhost:4000/api/drill-sessions/$SID/next \
  -H 'content-type: application/json' -d '{}' | jq -r .drill.attempt_id)
curl -s -X POST localhost:4000/api/drill-attempts/$ATT/grade \
  -H 'content-type: application/json' \
  -d '{"transcript":"composite B-tree on (category_id, price), equality then order, verify with EXPLAIN ANALYZE","duration_seconds":45}' | jq
```

## Testing & smoke

Three layers, fastest to slowest:

| Layer | Command | What it proves |
| --- | --- | --- |
| Unit + route tests | `pnpm -r test` | rotation engine, offline grader, AND HTTP routes (session ownership, draft activation, dry-run grader, tool-call dispatch, rubric editing). 20 tests. Runs Express in-process on an ephemeral port, no network. |
| REST drill loop | `pnpm smoke:drill-loop` | end-to-end loop over HTTP for N drills with the offline grader — verifies rotation produces variety, weakness state moves, mixed verdicts. Boots its own backend on an isolated DB. |
| Browser drill loop | `pnpm smoke:browser` | exercises App.tsx in Chromium (no mic): Start → type answer → Submit → grade panel renders → Next drill → question changes. |
| Realtime WebRTC | `pnpm smoke:realtime` | full voice path: launches Chromium with `--use-file-for-fake-audio-capture` against a Mumbli WAV, asserts the model connects, ASR transcript appears, and at least 1 backend tool gets dispatched. Requires `OPENAI_API_KEY`. |
| Realtime multi-turn | `pnpm smoke:realtime:multi` | same harness, longer wait (~90 s), asserts **≥ 2 distinct** tool calls — proves the agent runs the actual drill loop (e.g. `submit_answer_transcript` then `grade_attempt`) rather than just calling `get_next_drill` once and stopping. |
| Realtime autonomy | `pnpm smoke:realtime:loop` | strictest — wait up to ~2 min, asserts **≥ 3 total tool calls including `get_next_drill`**. Proves the agent calls `submit_answer_transcript` → `grade_attempt` → `get_next_drill` autonomously. Verifies LOCAL.md §18 ("backend owns curriculum, model drives it"). |

Run everything:

```bash
pnpm -r test                # unit
pnpm smoke:drill-loop       # offline REST loop
pnpm smoke:browser          # offline browser loop
pnpm smoke:realtime         # online realtime
```

### Useful overrides

```bash
# point smokes at an already-running stack instead of starting one
USE_EXISTING_BACKEND=1 USE_EXISTING_FRONTEND=1 pnpm smoke:browser

# specific Mumbli WAV (otherwise picks the latest >32 KB)
REALTIME_SMOKE_AUDIO="/absolute/path/sample.wav" pnpm smoke:realtime

# show the browser
HEADLESS=0 pnpm smoke:realtime

# don't fail the realtime smoke if the agent skips tool calls
REALTIME_SMOKE_REQUIRE_TOOL=0 pnpm smoke:realtime

# how long to wait for the agent's first tool call (default 20s)
REALTIME_SMOKE_TOOL_WAIT_MS=30000 pnpm smoke:realtime
```

The realtime smoke output includes a screenshot path and a tail of recent
Realtime server events so you can confirm `response.output_audio.done`,
`input_audio_buffer.speech_stopped`, and transcription deltas all arrived.

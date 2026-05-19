# GPT Realtime Interview Drill Coach

Browser-based voice drill app that trains fast staff/system-design interview
reflexes. Implementation of the spec in `LOCAL.md` (gitignored).

The voice agent runs on OpenAI GPT Realtime over WebRTC. The backend owns the
curriculum, rotation, attempts, grading, and weakness state — the model is the
voice/interview surface, not the brain (LOCAL.md §18).

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
| `GET`  | `/api/cards/due` | due review cards |
| `GET`  | `/api/progress` | per-topic skill state |
| `GET`  | `/api/drills` | drill bank browse |

## Seed drills

YAML files in `apps/backend/seeds/drills/` are loaded on every server start
(`drill_items.upsert` so edits are picked up). Schema follows LOCAL.md §16.

To add a drill: create or edit a YAML file, run `pnpm --filter @drill/backend seed`,
or just restart the backend.

## What is *not* in the MVP

Mapped to LOCAL.md §15:

* **Postgres** — MVP uses SQLite. Schema is portable; the migration file is the
  obvious place to swap when you need multi-writer or hosted infra.
* **Template-based generation (Layer 2)** — schema exists (`drill_templates`),
  no generator wired yet.
* **Admin/content editor**, **payments**, **Anki sync**, **per-user auth** —
  not in MVP.
* **Full backend-driven tool protocol** for the voice agent. Today the
  frontend drives the drill loop via REST while the agent reads the question
  aloud and the transcript flows back. The tool surface (LOCAL.md §6) is the
  natural next step: define tools in the realtime session config and handle
  `response.function_call_arguments.done` on the data channel.

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
| Unit tests | `pnpm -r test` | rotation engine selection rules, offline grader scoring, red-flag penalty, card generation. No network. |
| REST drill loop | `pnpm smoke:drill-loop` | end-to-end loop over HTTP for N drills with the offline grader — verifies rotation produces variety, weakness state moves, mixed verdicts. Boots its own backend on an isolated DB. |
| Browser drill loop | `pnpm smoke:browser` | exercises App.tsx in Chromium (no mic): Start → type answer → Submit → grade panel renders → Next drill → question changes. |
| Realtime WebRTC | `pnpm smoke:realtime` | full voice path: launches Chromium with `--use-file-for-fake-audio-capture` against a Mumbli WAV, asserts the model connects and ASR transcript appears. Requires `OPENAI_API_KEY`. |

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
```

The realtime smoke output includes a screenshot path and a tail of recent
Realtime server events so you can confirm `response.output_audio.done`,
`input_audio_buffer.speech_stopped`, and transcription deltas all arrived.

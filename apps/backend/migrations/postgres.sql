-- Postgres-flavored translation of apps/backend/src/db/migrations.ts.
-- Mirrors LOCAL.md §7 exactly. Used by docker-compose to seed schema on
-- first boot. The MVP runtime still uses better-sqlite3; this file is the
-- ground truth for the Postgres swap.
--
-- Differences vs the SQLite migration:
--   • TEXT ids retained for app compatibility: seeded drill IDs are stable
--     slugs (api_idempotent_post_001) and MVP user IDs are strings
--     (demo-user), not UUIDs.
--   • JSONB instead of TEXT-with-JSON-strings for rubric, expected_answer,
--     created_cards.
--   • TIMESTAMPTZ instead of TEXT for *_at columns.
--   • TEXT[] (native array) for tags.
--   • BOOLEAN instead of INTEGER 0/1 for is_active.
--   • SERIAL / IDENTITY for session_events.id.

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  display_name  TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS drill_items (
  id                       TEXT PRIMARY KEY,
  topic                    TEXT NOT NULL,
  subtopic                 TEXT NOT NULL,
  difficulty               INT  NOT NULL CHECK (difficulty BETWEEN 1 AND 5),
  trap_type                TEXT,
  question_text            TEXT NOT NULL,
  expected_answer          JSONB NOT NULL,
  rubric                   JSONB NOT NULL,
  canonical_short_answer   TEXT NOT NULL,
  canonical_deep_answer    TEXT,
  tags                     TEXT[] NOT NULL DEFAULT '{}',
  is_active                BOOLEAN NOT NULL DEFAULT true,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_drill_items_topic ON drill_items (topic);
CREATE INDEX IF NOT EXISTS idx_drill_items_active ON drill_items (is_active);

CREATE TABLE IF NOT EXISTS drill_templates (
  id                          TEXT PRIMARY KEY,
  topic                       TEXT NOT NULL,
  subtopic                    TEXT NOT NULL,
  difficulty                  INT  NOT NULL,
  template_text               TEXT NOT NULL,
  variable_schema             JSONB NOT NULL,
  rubric_template             JSONB NOT NULL,
  canonical_answer_template   TEXT NOT NULL,
  trap_type                   TEXT,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS drill_sessions (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  mode        TEXT NOT NULL DEFAULT 'mixed',
  started_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at    TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS drill_attempts (
  id                TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL,
  session_id        TEXT NOT NULL,
  drill_id          TEXT NOT NULL REFERENCES drill_items(id),
  transcript        TEXT,
  duration_seconds  INT,
  score             NUMERIC(4,3),
  verdict           TEXT,
  missed_points     JSONB,
  ideal_answer      TEXT,
  created_cards     JSONB,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_drill_attempts_user_created
  ON drill_attempts (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_drill_attempts_session
  ON drill_attempts (session_id, created_at DESC);

CREATE TABLE IF NOT EXISTS user_skill_state (
  user_id         TEXT NOT NULL,
  topic           TEXT NOT NULL,
  subtopic        TEXT NOT NULL,
  exposure_count  INT  NOT NULL DEFAULT 0,
  last_seen_at    TIMESTAMPTZ,
  avg_score       NUMERIC(4,3),
  weakness_score  NUMERIC(4,3) NOT NULL DEFAULT 0.5,
  next_due_at     TIMESTAMPTZ,
  PRIMARY KEY (user_id, topic, subtopic)
);

CREATE TABLE IF NOT EXISTS generated_cards (
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL,
  drill_id       TEXT REFERENCES drill_items(id),
  front          TEXT NOT NULL,
  back           TEXT NOT NULL,
  topic          TEXT,
  subtopic       TEXT,
  next_due_at    TIMESTAMPTZ,
  ease           NUMERIC(4,2) NOT NULL DEFAULT 2.5,
  interval_days  INT NOT NULL DEFAULT 0,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cards_user_due
  ON generated_cards (user_id, next_due_at);

CREATE TABLE IF NOT EXISTS session_events (
  id          BIGSERIAL PRIMARY KEY,
  session_id  TEXT NOT NULL,
  event_type  TEXT NOT NULL,
  payload     JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS usage_events (
  id                  BIGSERIAL PRIMARY KEY,
  user_id             TEXT NOT NULL,
  session_id          TEXT NOT NULL,
  attempt_id          TEXT,
  drill_id            TEXT,
  source              TEXT NOT NULL,
  model               TEXT,
  response_id         TEXT UNIQUE,
  input_tokens        INT NOT NULL DEFAULT 0,
  output_tokens       INT NOT NULL DEFAULT 0,
  total_tokens        INT NOT NULL DEFAULT 0,
  input_text_tokens   INT NOT NULL DEFAULT 0,
  input_audio_tokens  INT NOT NULL DEFAULT 0,
  cached_tokens       INT NOT NULL DEFAULT 0,
  output_text_tokens  INT NOT NULL DEFAULT 0,
  output_audio_tokens INT NOT NULL DEFAULT 0,
  estimated_cost_usd  NUMERIC(12,8),
  raw_usage           JSONB,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_usage_events_session
  ON usage_events (session_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_usage_events_attempt
  ON usage_events (attempt_id);

CREATE INDEX IF NOT EXISTS idx_usage_events_drill
  ON usage_events (user_id, drill_id);

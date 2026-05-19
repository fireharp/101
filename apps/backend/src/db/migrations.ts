import { db } from "./index.js";

/**
 * Schema mirrors LOCAL.md §7 but uses SQLite types for MVP simplicity.
 * Postgres-specific bits (UUID, JSONB, ARRAY, TIMESTAMPTZ) become TEXT.
 * UUIDs are generated in app code; JSON is stored as TEXT and parsed in
 * the data layer.
 */
export function runMigrations(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      display_name TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS drill_items (
      id TEXT PRIMARY KEY,
      topic TEXT NOT NULL,
      subtopic TEXT NOT NULL,
      difficulty INTEGER NOT NULL CHECK (difficulty BETWEEN 1 AND 5),
      trap_type TEXT,
      question_text TEXT NOT NULL,
      expected_answer TEXT NOT NULL,
      rubric TEXT NOT NULL,
      canonical_short_answer TEXT NOT NULL,
      canonical_deep_answer TEXT,
      tags TEXT NOT NULL DEFAULT '[]',
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS drill_templates (
      id TEXT PRIMARY KEY,
      topic TEXT NOT NULL,
      subtopic TEXT NOT NULL,
      difficulty INTEGER NOT NULL,
      template_text TEXT NOT NULL,
      variable_schema TEXT NOT NULL,
      rubric_template TEXT NOT NULL,
      canonical_answer_template TEXT NOT NULL,
      trap_type TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS drill_sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      mode TEXT NOT NULL DEFAULT 'mixed',
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      ended_at TEXT
    );

    CREATE TABLE IF NOT EXISTS drill_attempts (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      drill_id TEXT NOT NULL REFERENCES drill_items(id),
      transcript TEXT,
      duration_seconds INTEGER,
      score REAL,
      verdict TEXT,
      missed_points TEXT,
      ideal_answer TEXT,
      created_cards TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_drill_attempts_user_created
      ON drill_attempts(user_id, created_at DESC);

    CREATE INDEX IF NOT EXISTS idx_drill_attempts_session
      ON drill_attempts(session_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS user_skill_state (
      user_id TEXT NOT NULL,
      topic TEXT NOT NULL,
      subtopic TEXT NOT NULL,
      exposure_count INTEGER NOT NULL DEFAULT 0,
      last_seen_at TEXT,
      avg_score REAL,
      weakness_score REAL NOT NULL DEFAULT 0.5,
      next_due_at TEXT,
      PRIMARY KEY (user_id, topic, subtopic)
    );

    CREATE TABLE IF NOT EXISTS generated_cards (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      drill_id TEXT REFERENCES drill_items(id),
      front TEXT NOT NULL,
      back TEXT NOT NULL,
      topic TEXT,
      subtopic TEXT,
      next_due_at TEXT,
      ease REAL NOT NULL DEFAULT 2.5,
      interval_days INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_cards_user_due
      ON generated_cards(user_id, next_due_at);

    CREATE TABLE IF NOT EXISTS session_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      payload TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS usage_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      attempt_id TEXT,
      drill_id TEXT,
      source TEXT NOT NULL,
      model TEXT,
      response_id TEXT,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      input_text_tokens INTEGER NOT NULL DEFAULT 0,
      input_audio_tokens INTEGER NOT NULL DEFAULT 0,
      cached_tokens INTEGER NOT NULL DEFAULT 0,
      output_text_tokens INTEGER NOT NULL DEFAULT 0,
      output_audio_tokens INTEGER NOT NULL DEFAULT 0,
      estimated_cost_usd REAL,
      raw_usage TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_usage_events_session
      ON usage_events(session_id, created_at DESC);

    CREATE INDEX IF NOT EXISTS idx_usage_events_attempt
      ON usage_events(attempt_id);

    CREATE INDEX IF NOT EXISTS idx_usage_events_drill
      ON usage_events(user_id, drill_id);

    CREATE UNIQUE INDEX IF NOT EXISTS idx_usage_events_response
      ON usage_events(response_id)
      WHERE response_id IS NOT NULL;
  `);
}

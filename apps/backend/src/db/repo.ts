import { randomUUID } from "node:crypto";
import { db } from "./index.js";
import type {
  DrillAttempt,
  DrillItem,
  DrillItemRow,
  GeneratedCard,
  Mode,
  TokenUsage,
  UserSkillState,
} from "../types.js";

function rowToDrillItem(row: DrillItemRow): DrillItem {
  return {
    id: row.id,
    topic: row.topic,
    subtopic: row.subtopic,
    difficulty: row.difficulty as DrillItem["difficulty"],
    trap_type: row.trap_type,
    question_text: row.question_text,
    expected_answer: JSON.parse(row.expected_answer),
    rubric: JSON.parse(row.rubric),
    canonical_short_answer: row.canonical_short_answer,
    canonical_deep_answer: row.canonical_deep_answer,
    tags: JSON.parse(row.tags ?? "[]"),
    is_active: row.is_active === 1,
    created_at: row.created_at,
  };
}

export const drills = {
  upsert(drill: Omit<DrillItem, "created_at">): void {
    const stmt = db.prepare(`
      INSERT INTO drill_items
        (id, topic, subtopic, difficulty, trap_type, question_text,
         expected_answer, rubric, canonical_short_answer,
         canonical_deep_answer, tags, is_active)
      VALUES
        (@id, @topic, @subtopic, @difficulty, @trap_type, @question_text,
         @expected_answer, @rubric, @canonical_short_answer,
         @canonical_deep_answer, @tags, @is_active)
      ON CONFLICT(id) DO UPDATE SET
        topic=excluded.topic,
        subtopic=excluded.subtopic,
        difficulty=excluded.difficulty,
        trap_type=excluded.trap_type,
        question_text=excluded.question_text,
        expected_answer=excluded.expected_answer,
        rubric=excluded.rubric,
        canonical_short_answer=excluded.canonical_short_answer,
        canonical_deep_answer=excluded.canonical_deep_answer,
        tags=excluded.tags,
        is_active=excluded.is_active
    `);
    stmt.run({
      id: drill.id,
      topic: drill.topic,
      subtopic: drill.subtopic,
      difficulty: drill.difficulty,
      trap_type: drill.trap_type,
      question_text: drill.question_text,
      expected_answer: JSON.stringify(drill.expected_answer),
      rubric: JSON.stringify(drill.rubric),
      canonical_short_answer: drill.canonical_short_answer,
      canonical_deep_answer: drill.canonical_deep_answer,
      tags: JSON.stringify(drill.tags ?? []),
      is_active: drill.is_active ? 1 : 0,
    });
  },

  get(id: string): DrillItem | null {
    const row = db
      .prepare("SELECT * FROM drill_items WHERE id = ?")
      .get(id) as DrillItemRow | undefined;
    return row ? rowToDrillItem(row) : null;
  },

  list(opts: { mode?: Mode; topic?: string; active?: boolean } = {}): DrillItem[] {
    const where: string[] = [];
    const params: Record<string, unknown> = {};
    if (opts.active !== undefined) {
      where.push("is_active = @active");
      params.active = opts.active ? 1 : 0;
    }
    if (opts.topic) {
      where.push("topic = @topic");
      params.topic = opts.topic;
    }
    if (opts.mode && opts.mode !== "mixed" && opts.mode !== "weak_topics" && opts.mode !== "mock_interview") {
      // Map known modes onto topic filters.
      const modeTopicMap: Record<string, string> = {
        db_indexes: "database",
        system_design: "system_design",
      };
      const topic = modeTopicMap[opts.mode];
      if (topic) {
        where.push("topic = @modeTopic");
        params.modeTopic = topic;
      }
    }
    const sql =
      "SELECT * FROM drill_items" +
      (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
      " ORDER BY topic, subtopic, difficulty";
    const rows = db.prepare(sql).all(params) as DrillItemRow[];
    return rows.map(rowToDrillItem);
  },

  count(): number {
    const row = db.prepare("SELECT COUNT(*) AS c FROM drill_items").get() as {
      c: number;
    };
    return row.c;
  },

  /**
   * Drill bank distribution stats for the admin overview. Returns active vs
   * draft counts plus three buckets (topic, difficulty, trap_type) so
   * content authors can see where the gaps are.
   */
  stats(): {
    total: number;
    active: number;
    drafts: number;
    by_topic: { topic: string; active: number; drafts: number }[];
    by_difficulty: { difficulty: number; active: number; drafts: number }[];
    by_trap_type: { trap_type: string; count: number }[];
  } {
    const totals = db
      .prepare(
        `SELECT
           SUM(is_active = 1) AS active,
           SUM(is_active = 0) AS drafts,
           COUNT(*) AS total
         FROM drill_items`,
      )
      .get() as { active: number; drafts: number; total: number };

    const byTopic = db
      .prepare(
        `SELECT topic,
                SUM(is_active = 1) AS active,
                SUM(is_active = 0) AS drafts
           FROM drill_items
           GROUP BY topic
           ORDER BY topic`,
      )
      .all() as { topic: string; active: number; drafts: number }[];

    const byDifficulty = db
      .prepare(
        `SELECT difficulty,
                SUM(is_active = 1) AS active,
                SUM(is_active = 0) AS drafts
           FROM drill_items
           GROUP BY difficulty
           ORDER BY difficulty`,
      )
      .all() as { difficulty: number; active: number; drafts: number }[];

    const byTrap = db
      .prepare(
        `SELECT COALESCE(trap_type, '(none)') AS trap_type,
                COUNT(*) AS count
           FROM drill_items
           WHERE is_active = 1
           GROUP BY trap_type
           ORDER BY count DESC, trap_type ASC`,
      )
      .all() as { trap_type: string; count: number }[];

    return {
      total: totals.total ?? 0,
      active: totals.active ?? 0,
      drafts: totals.drafts ?? 0,
      by_topic: byTopic,
      by_difficulty: byDifficulty,
      by_trap_type: byTrap,
    };
  },

  /**
   * Partial update of editable fields. Returns the updated drill or null
   * if not found.
   */
  patch(
    id: string,
    fields: {
      question_text?: string;
      canonical_short_answer?: string;
      canonical_deep_answer?: string | null;
      difficulty?: number;
      trap_type?: string | null;
      rubric?: {
        must_have: string[];
        nice_to_have: string[];
        red_flags: string[];
      };
      tags?: string[];
    },
  ): DrillItem | null {
    const existing = this.get(id);
    if (!existing) return null;
    const merged = {
      ...existing,
      question_text: fields.question_text ?? existing.question_text,
      canonical_short_answer:
        fields.canonical_short_answer ?? existing.canonical_short_answer,
      canonical_deep_answer:
        fields.canonical_deep_answer !== undefined
          ? fields.canonical_deep_answer
          : existing.canonical_deep_answer,
      difficulty: (fields.difficulty ??
        existing.difficulty) as DrillItem["difficulty"],
      trap_type:
        fields.trap_type !== undefined ? fields.trap_type : existing.trap_type,
      rubric: fields.rubric ?? existing.rubric,
      tags: fields.tags ?? existing.tags,
      // If the rubric changed, mirror to expected_answer too — they used to
      // diverge but in our app they're effectively the same surface.
      expected_answer: fields.rubric ?? existing.expected_answer,
      is_active: existing.is_active,
    };
    this.upsert(merged);
    return this.get(id);
  },

  setActive(id: string, active: boolean): boolean {
    const info = db
      .prepare("UPDATE drill_items SET is_active = ? WHERE id = ?")
      .run(active ? 1 : 0, id);
    return info.changes > 0;
  },

  remove(id: string, onlyIfInactive = true): boolean {
    if (onlyIfInactive) {
      const info = db
        .prepare("DELETE FROM drill_items WHERE id = ? AND is_active = 0")
        .run(id);
      return info.changes > 0;
    }
    const info = db.prepare("DELETE FROM drill_items WHERE id = ?").run(id);
    return info.changes > 0;
  },

  listDrafts(): DrillItem[] {
    const rows = db
      .prepare(
        "SELECT * FROM drill_items WHERE is_active = 0 ORDER BY created_at DESC",
      )
      .all() as DrillItemRow[];
    return rows.map(rowToDrillItem);
  },
};

export interface SessionRow {
  id: string;
  user_id: string;
  mode: Mode;
  started_at: string;
  ended_at: string | null;
}

export const sessions = {
  create(userId: string, mode: Mode = "mixed"): SessionRow {
    const id = randomUUID();
    // RETURNING * so the in-memory object matches the persisted row exactly
    // (same timestamp source, same format) — otherwise the JS-side
    // toISOString() drifts from SQLite's default by a few ms.
    const row = db
      .prepare(
        `INSERT INTO drill_sessions (id, user_id, mode) VALUES (?, ?, ?)
         RETURNING *`,
      )
      .get(id, userId, mode) as SessionRow;
    return row;
  },
  end(id: string): void {
    db.prepare(
      "UPDATE drill_sessions SET ended_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?",
    ).run(id);
  },
  get(id: string): SessionRow | null {
    return (
      (db
        .prepare("SELECT * FROM drill_sessions WHERE id = ?")
        .get(id) as SessionRow | undefined) ?? null
    );
  },

  /**
   * Recent sessions for a user, newest first, with rollup stats. Drives the
   * history panel in the UI so users can revisit a finished session's
   * summary without remembering its id.
   */
  recent(
    userId: string,
    limit = 25,
  ): {
    id: string;
    mode: Mode;
    started_at: string;
    ended_at: string | null;
    drills_attempted: number;
    drills_graded: number;
    average_score: number;
  }[] {
    return db
      .prepare(
        `SELECT
           s.id              AS id,
           s.mode            AS mode,
           s.started_at      AS started_at,
           s.ended_at        AS ended_at,
           COUNT(a.id)       AS drills_attempted,
           SUM(a.score IS NOT NULL) AS drills_graded,
           COALESCE(AVG(a.score), 0) AS average_score
         FROM drill_sessions s
         LEFT JOIN drill_attempts a ON a.session_id = s.id
         WHERE s.user_id = ?
         GROUP BY s.id
         ORDER BY s.started_at DESC, s.rowid DESC
         LIMIT ?`,
      )
      .all(userId, limit) as {
      id: string;
      mode: Mode;
      started_at: string;
      ended_at: string | null;
      drills_attempted: number;
      drills_graded: number;
      average_score: number;
    }[];
  },
};

export const users = {
  ensure(userId: string, displayName?: string): void {
    db.prepare(
      "INSERT OR IGNORE INTO users (id, display_name) VALUES (?, ?)",
    ).run(userId, displayName ?? null);
  },
};

export interface DrillPerformance {
  drill_id: string;
  topic: string;
  subtopic: string;
  difficulty: number;
  question_text: string;
  attempts: number;
  graded: number;
  avg_score: number;
  best_score: number;
  worst_score: number;
  last_seen_at: string | null;
  last_score: number | null;
  last_verdict: string | null;
}

export const attempts = {
  /**
   * Per-drill performance for a user. Joins drill_attempts → drill_items so
   * the UI can show which specific drills consistently underperform.
   * Filters to drills with at least one graded attempt.
   */
  performanceByDrill(userId: string, limit = 50): DrillPerformance[] {
    return db
      .prepare(
        `SELECT
           d.id              AS drill_id,
           d.topic           AS topic,
           d.subtopic        AS subtopic,
           d.difficulty      AS difficulty,
           d.question_text   AS question_text,
           COUNT(a.id)       AS attempts,
           SUM(a.score IS NOT NULL) AS graded,
           AVG(a.score)      AS avg_score,
           MAX(a.score)      AS best_score,
           MIN(a.score)      AS worst_score,
           MAX(a.created_at) AS last_seen_at,
           (
             SELECT a2.score
               FROM drill_attempts a2
              WHERE a2.user_id = ? AND a2.drill_id = d.id
                AND a2.score IS NOT NULL
              ORDER BY a2.created_at DESC
              LIMIT 1
           ) AS last_score,
           (
             SELECT a2.verdict
               FROM drill_attempts a2
              WHERE a2.user_id = ? AND a2.drill_id = d.id
                AND a2.score IS NOT NULL
              ORDER BY a2.created_at DESC
              LIMIT 1
           ) AS last_verdict
         FROM drill_items d
         JOIN drill_attempts a ON a.drill_id = d.id AND a.user_id = ?
         WHERE a.score IS NOT NULL
         GROUP BY d.id
         ORDER BY avg_score ASC, attempts DESC
         LIMIT ?`,
      )
      .all(userId, userId, userId, limit) as DrillPerformance[];
  },

  createPending(opts: {
    user_id: string;
    session_id: string;
    drill_id: string;
  }): DrillAttempt {
    const id = randomUUID();
    // RETURNING created_at so the in-memory created_at matches storage.
    const row = db
      .prepare(
        `INSERT INTO drill_attempts (id, user_id, session_id, drill_id)
         VALUES (?, ?, ?, ?)
         RETURNING created_at`,
      )
      .get(id, opts.user_id, opts.session_id, opts.drill_id) as {
      created_at: string;
    };
    return {
      id,
      user_id: opts.user_id,
      session_id: opts.session_id,
      drill_id: opts.drill_id,
      transcript: null,
      duration_seconds: null,
      score: null,
      verdict: null,
      missed_points: null,
      ideal_answer: null,
      created_cards: null,
      created_at: row.created_at,
    };
  },

  updateTranscript(
    id: string,
    transcript: string,
    durationSeconds: number,
  ): void {
    db.prepare(
      `UPDATE drill_attempts
         SET transcript = ?, duration_seconds = ?
       WHERE id = ?`,
    ).run(transcript, durationSeconds, id);
  },

  updateGrade(
    id: string,
    opts: {
      score: number;
      verdict: "pass" | "borderline" | "fail";
      missed_points: string[];
      ideal_answer: string;
      created_cards: GeneratedCard[];
    },
  ): void {
    db.prepare(
      `UPDATE drill_attempts
         SET score = ?, verdict = ?, missed_points = ?, ideal_answer = ?, created_cards = ?
       WHERE id = ?`,
    ).run(
      opts.score,
      opts.verdict,
      JSON.stringify(opts.missed_points),
      opts.ideal_answer,
      JSON.stringify(opts.created_cards),
      id,
    );
  },

  get(id: string): DrillAttempt | null {
    const row = db
      .prepare("SELECT * FROM drill_attempts WHERE id = ?")
      .get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      id: row.id as string,
      user_id: row.user_id as string,
      session_id: row.session_id as string,
      drill_id: row.drill_id as string,
      transcript: (row.transcript as string | null) ?? null,
      duration_seconds: (row.duration_seconds as number | null) ?? null,
      score: (row.score as number | null) ?? null,
      verdict: (row.verdict as DrillAttempt["verdict"]) ?? null,
      missed_points: row.missed_points
        ? JSON.parse(row.missed_points as string)
        : null,
      ideal_answer: (row.ideal_answer as string | null) ?? null,
      created_cards: row.created_cards
        ? JSON.parse(row.created_cards as string)
        : null,
      created_at: row.created_at as string,
    };
  },

  /**
   * Returns prior graded attempts for this (user, drill), newest first.
   * Used to show "last time you scored 0.42, time before 0.55" deltas.
   */
  priorForDrill(
    userId: string,
    drillId: string,
    limit = 5,
  ): { score: number; verdict: string | null; created_at: string }[] {
    return db
      .prepare(
        `SELECT score, verdict, created_at
           FROM drill_attempts
           WHERE user_id = ? AND drill_id = ? AND score IS NOT NULL
           ORDER BY created_at DESC
           LIMIT ?`,
      )
      .all(userId, drillId, limit) as {
      score: number;
      verdict: string | null;
      created_at: string;
    }[];
  },

  recentDrillIds(userId: string, limit = 20): string[] {
    const rows = db
      .prepare(
        `SELECT drill_id FROM drill_attempts
           WHERE user_id = ?
           ORDER BY created_at DESC
           LIMIT ?`,
      )
      .all(userId, limit) as { drill_id: string }[];
    return rows.map((r) => r.drill_id);
  },

  listForSession(sessionId: string): DrillAttempt[] {
    const rows = db
      .prepare(
        `SELECT * FROM drill_attempts WHERE session_id = ? ORDER BY created_at ASC`,
      )
      .all(sessionId) as Record<string, unknown>[];
    return rows.map((row) => ({
      id: row.id as string,
      user_id: row.user_id as string,
      session_id: row.session_id as string,
      drill_id: row.drill_id as string,
      transcript: (row.transcript as string | null) ?? null,
      duration_seconds: (row.duration_seconds as number | null) ?? null,
      score: (row.score as number | null) ?? null,
      verdict: (row.verdict as DrillAttempt["verdict"]) ?? null,
      missed_points: row.missed_points
        ? JSON.parse(row.missed_points as string)
        : null,
      ideal_answer: (row.ideal_answer as string | null) ?? null,
      created_cards: row.created_cards
        ? JSON.parse(row.created_cards as string)
        : null,
      created_at: row.created_at as string,
    }));
  },
};

export const skillState = {
  getAll(userId: string): UserSkillState[] {
    return db
      .prepare("SELECT * FROM user_skill_state WHERE user_id = ?")
      .all(userId) as UserSkillState[];
  },

  upsertAfterAttempt(opts: {
    user_id: string;
    topic: string;
    subtopic: string;
    score: number;
  }): void {
    const existing = db
      .prepare(
        `SELECT * FROM user_skill_state
           WHERE user_id = ? AND topic = ? AND subtopic = ?`,
      )
      .get(opts.user_id, opts.topic, opts.subtopic) as
      | UserSkillState
      | undefined;

    if (!existing) {
      const weakness = 1 - opts.score;
      db.prepare(
        `INSERT INTO user_skill_state
           (user_id, topic, subtopic, exposure_count, last_seen_at,
            avg_score, weakness_score, next_due_at)
         VALUES (?, ?, ?, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+1 day'))`,
      ).run(opts.user_id, opts.topic, opts.subtopic, opts.score, weakness);
      return;
    }

    const newCount = existing.exposure_count + 1;
    const newAvg =
      ((existing.avg_score ?? opts.score) * existing.exposure_count +
        opts.score) /
      newCount;
    const weakness = clamp(0, 1, 1 - newAvg);
    const intervalDays = nextIntervalDays(weakness, newCount);

    db.prepare(
      `UPDATE user_skill_state
         SET exposure_count = ?,
             last_seen_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
             avg_score = ?,
             weakness_score = ?,
             next_due_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?)
         WHERE user_id = ? AND topic = ? AND subtopic = ?`,
    ).run(
      newCount,
      newAvg,
      weakness,
      `+${intervalDays} day`,
      opts.user_id,
      opts.topic,
      opts.subtopic,
    );
  },
};

function clamp(min: number, max: number, n: number): number {
  return Math.max(min, Math.min(max, n));
}

function nextIntervalDays(weakness: number, exposure: number): number {
  // Strong concepts (weakness < 0.2): long interval. Weak: revisit fast.
  const base = weakness < 0.2 ? 6 : weakness < 0.4 ? 3 : weakness < 0.6 ? 1 : 0;
  return Math.max(0, base + Math.floor(exposure / 5));
}

export type EventType =
  | "session_created"
  | "session_resumed"
  | "drill_picked"
  | "transcript_submitted"
  | "grade_completed"
  | "draft_activated"
  | "draft_deactivated"
  | "draft_discarded"
  | "drill_imported"
  | "rubric_edited"
  | "session_ended";

export const ADMIN_AUDIT_SESSION_ID = "__admin__";

export interface SessionEvent {
  id: number;
  session_id: string;
  event_type: EventType;
  payload: Record<string, unknown> | null;
  created_at: string;
}

/**
 * session_events is the audit log defined in LOCAL.md §7. Every meaningful
 * transition inside a drill loop gets a row so we can replay or analyse
 * sessions later without re-doing math from drill_attempts joins.
 */
export const events = {
  log(
    sessionId: string,
    event_type: EventType,
    payload?: Record<string, unknown>,
  ): void {
    db.prepare(
      `INSERT INTO session_events (session_id, event_type, payload)
       VALUES (?, ?, ?)`,
    ).run(
      sessionId,
      event_type,
      payload ? JSON.stringify(payload) : null,
    );
  },

  listForSession(sessionId: string, limit = 200): SessionEvent[] {
    const rows = db
      .prepare(
        `SELECT id, session_id, event_type, payload, created_at
           FROM session_events
           WHERE session_id = ?
           ORDER BY id ASC
           LIMIT ?`,
      )
      .all(sessionId, limit) as {
      id: number;
      session_id: string;
      event_type: string;
      payload: string | null;
      created_at: string;
    }[];
    return rows.map((r) => ({
      id: r.id,
      session_id: r.session_id,
      event_type: r.event_type as EventType,
      payload: r.payload ? JSON.parse(r.payload) : null,
      created_at: r.created_at,
    }));
  },

  countForSession(sessionId: string): number {
    return (
      db
        .prepare(
          `SELECT COUNT(*) AS c FROM session_events WHERE session_id = ?`,
        )
        .get(sessionId) as { c: number }
    ).c;
  },

  /**
   * Admin actions (drill imports, draft activate / deactivate / discard,
   * rubric edits) are written under sentinel session_id `__admin__` so they
   * stay out of per-session timelines but remain queryable as an admin audit
   * log (LOCAL.md §13).
   *
   * `types` filters by event_type (OR-match). `sinceIso` filters by
   * created_at ≥ that ISO timestamp. Both are optional; with neither set
   * this returns the most-recent `limit` admin events.
   */
  listAdmin(opts: {
    limit?: number;
    types?: EventType[];
    sinceIso?: string;
  } = {}): SessionEvent[] {
    const limit = Math.max(1, Math.min(500, opts.limit ?? 100));
    const clauses = ["session_id = ?"];
    const params: unknown[] = [ADMIN_AUDIT_SESSION_ID];
    if (opts.types && opts.types.length > 0) {
      const placeholders = opts.types.map(() => "?").join(",");
      clauses.push(`event_type IN (${placeholders})`);
      params.push(...opts.types);
    }
    if (opts.sinceIso) {
      // SQLite stores created_at as 'YYYY-MM-DD HH:MM:SS' but the caller
      // passes ISO 8601 ('...T...Z'). Normalise both sides via datetime()
      // so the comparison is on parsed timestamps, not raw strings.
      clauses.push("datetime(created_at) >= datetime(?)");
      params.push(opts.sinceIso);
    }
    params.push(limit);
    const rows = db
      .prepare(
        `SELECT id, session_id, event_type, payload, created_at
           FROM session_events
           WHERE ${clauses.join(" AND ")}
           ORDER BY id DESC
           LIMIT ?`,
      )
      .all(...params) as {
      id: number;
      session_id: string;
      event_type: string;
      payload: string | null;
      created_at: string;
    }[];
    return rows.map((r) => ({
      id: r.id,
      session_id: r.session_id,
      event_type: r.event_type as EventType,
      payload: r.payload ? JSON.parse(r.payload) : null,
      created_at: r.created_at,
    }));
  },
};

export type UsageSource =
  | "chat_grading"
  | "realtime_response"
  | "realtime_transcription";

export interface UsageRecord extends TokenUsage {
  user_id: string;
  session_id: string;
  attempt_id?: string | null;
  drill_id?: string | null;
  source: UsageSource;
  model?: string | null;
  response_id?: string | null;
}

export interface UsageTotals extends TokenUsage {
  events: number;
}

export interface UsageSourceTotals extends UsageTotals {
  source: UsageSource;
}

export interface UsageAttemptTotals extends UsageTotals {
  attempt_id: string;
  drill_id: string | null;
}

const usageSumSql = `
  COUNT(*) AS events,
  COALESCE(SUM(input_tokens), 0) AS input_tokens,
  COALESCE(SUM(output_tokens), 0) AS output_tokens,
  COALESCE(SUM(total_tokens), 0) AS total_tokens,
  COALESCE(SUM(input_text_tokens), 0) AS input_text_tokens,
  COALESCE(SUM(input_audio_tokens), 0) AS input_audio_tokens,
  COALESCE(SUM(cached_tokens), 0) AS cached_tokens,
  COALESCE(SUM(output_text_tokens), 0) AS output_text_tokens,
  COALESCE(SUM(output_audio_tokens), 0) AS output_audio_tokens,
  SUM(estimated_cost_usd) AS estimated_cost_usd
`;

function rowToUsageTotals(row: Record<string, unknown> | undefined): UsageTotals {
  return {
    events: Number(row?.events ?? 0),
    input_tokens: Number(row?.input_tokens ?? 0),
    output_tokens: Number(row?.output_tokens ?? 0),
    total_tokens: Number(row?.total_tokens ?? 0),
    input_text_tokens: Number(row?.input_text_tokens ?? 0),
    input_audio_tokens: Number(row?.input_audio_tokens ?? 0),
    cached_tokens: Number(row?.cached_tokens ?? 0),
    output_text_tokens: Number(row?.output_text_tokens ?? 0),
    output_audio_tokens: Number(row?.output_audio_tokens ?? 0),
    estimated_cost_usd:
      row?.estimated_cost_usd === null || row?.estimated_cost_usd === undefined
        ? null
        : Number(row.estimated_cost_usd),
  };
}

export const usageEvents = {
  record(record: UsageRecord): void {
    db.prepare(
      `INSERT OR IGNORE INTO usage_events
        (user_id, session_id, attempt_id, drill_id, source, model, response_id,
         input_tokens, output_tokens, total_tokens, input_text_tokens,
         input_audio_tokens, cached_tokens, output_text_tokens,
         output_audio_tokens, estimated_cost_usd, raw_usage)
       VALUES
        (@user_id, @session_id, @attempt_id, @drill_id, @source, @model,
         @response_id, @input_tokens, @output_tokens, @total_tokens,
         @input_text_tokens, @input_audio_tokens, @cached_tokens,
         @output_text_tokens, @output_audio_tokens, @estimated_cost_usd,
         @raw_usage)`,
    ).run({
      user_id: record.user_id,
      session_id: record.session_id,
      attempt_id: record.attempt_id ?? null,
      drill_id: record.drill_id ?? null,
      source: record.source,
      model: record.model ?? null,
      response_id: record.response_id ?? null,
      input_tokens: Math.max(0, Math.trunc(record.input_tokens)),
      output_tokens: Math.max(0, Math.trunc(record.output_tokens)),
      total_tokens: Math.max(0, Math.trunc(record.total_tokens)),
      input_text_tokens: Math.max(0, Math.trunc(record.input_text_tokens)),
      input_audio_tokens: Math.max(0, Math.trunc(record.input_audio_tokens)),
      cached_tokens: Math.max(0, Math.trunc(record.cached_tokens)),
      output_text_tokens: Math.max(0, Math.trunc(record.output_text_tokens)),
      output_audio_tokens: Math.max(0, Math.trunc(record.output_audio_tokens)),
      estimated_cost_usd: record.estimated_cost_usd,
      raw_usage: record.raw_usage ? JSON.stringify(record.raw_usage) : null,
    });
  },

  totalsForUser(userId: string): UsageTotals {
    const row = db
      .prepare(`SELECT ${usageSumSql} FROM usage_events WHERE user_id = ?`)
      .get(userId) as Record<string, unknown> | undefined;
    return rowToUsageTotals(row);
  },

  totalsForSession(userId: string, sessionId: string): UsageTotals {
    const row = db
      .prepare(
        `SELECT ${usageSumSql}
           FROM usage_events
          WHERE user_id = ? AND session_id = ?`,
      )
      .get(userId, sessionId) as Record<string, unknown> | undefined;
    return rowToUsageTotals(row);
  },

  totalsForAttempt(attemptId: string): UsageTotals {
    const row = db
      .prepare(`SELECT ${usageSumSql} FROM usage_events WHERE attempt_id = ?`)
      .get(attemptId) as Record<string, unknown> | undefined;
    return rowToUsageTotals(row);
  },

  totalsForDrill(userId: string, drillId: string): UsageTotals {
    const row = db
      .prepare(
        `SELECT ${usageSumSql}
           FROM usage_events
          WHERE user_id = ? AND drill_id = ?`,
      )
      .get(userId, drillId) as Record<string, unknown> | undefined;
    return rowToUsageTotals(row);
  },

  bySource(userId: string, sessionId?: string): UsageSourceTotals[] {
    const rows = db
      .prepare(
        `SELECT source, ${usageSumSql}
           FROM usage_events
          WHERE user_id = ?
            ${sessionId ? "AND session_id = ?" : ""}
          GROUP BY source
          ORDER BY total_tokens DESC`,
      )
      .all(...(sessionId ? [userId, sessionId] : [userId])) as Record<
      string,
      unknown
    >[];
    return rows.map((r) => ({
      source: r.source as UsageSource,
      ...rowToUsageTotals(r),
    }));
  },

  byAttemptForSession(userId: string, sessionId: string): UsageAttemptTotals[] {
    const rows = db
      .prepare(
        `SELECT attempt_id, drill_id, ${usageSumSql}
           FROM usage_events
          WHERE user_id = ? AND session_id = ? AND attempt_id IS NOT NULL
          GROUP BY attempt_id, drill_id
          ORDER BY total_tokens DESC`,
      )
      .all(userId, sessionId) as Record<string, unknown>[];
    return rows.map((r) => ({
      attempt_id: String(r.attempt_id ?? ""),
      drill_id: r.drill_id === null || r.drill_id === undefined ? null : String(r.drill_id),
      ...rowToUsageTotals(r),
    }));
  },
};

export const cards = {
  insertMany(userId: string, cardsIn: GeneratedCard[]): GeneratedCard[] {
    const stmt = db.prepare(
      `INSERT INTO generated_cards
         (id, user_id, drill_id, front, back, topic, subtopic, next_due_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+1 day'))`,
    );
    const out: GeneratedCard[] = [];
    const insertAll = db.transaction((items: GeneratedCard[]) => {
      for (const c of items) {
        const id = c.id ?? randomUUID();
        stmt.run(
          id,
          userId,
          c.drill_id ?? null,
          c.front,
          c.back,
          c.topic ?? null,
          c.subtopic ?? null,
        );
        out.push({ ...c, id });
      }
    });
    insertAll(cardsIn);
    return out;
  },

  due(userId: string, limit = 20): GeneratedCard[] {
    return db
      .prepare(
        `SELECT * FROM generated_cards
           WHERE user_id = ?
             AND (next_due_at IS NULL OR datetime(next_due_at) <= datetime('now'))
           ORDER BY next_due_at ASC
           LIMIT ?`,
      )
      .all(userId, limit) as GeneratedCard[];
  },

  all(userId: string): GeneratedCard[] {
    return db
      .prepare(
        `SELECT * FROM generated_cards WHERE user_id = ? ORDER BY created_at DESC`,
      )
      .all(userId) as GeneratedCard[];
  },

  /**
   * SM-2-lite review. `quality` is 0 (forgot) or 1 (knew it).
   *  - knew it: ease *= 1.1 (capped 3.5), interval = max(1, prev*ease) days
   *  - forgot:  ease *= 0.8 (min 1.3), interval = 0 (review again same day)
   */
  review(
    userId: string,
    cardId: string,
    quality: 0 | 1,
  ): { interval_days: number; ease: number; next_due_at: string } | null {
    const row = db
      .prepare(
        `SELECT ease, interval_days FROM generated_cards
           WHERE id = ? AND user_id = ?`,
      )
      .get(cardId, userId) as
      | { ease: number; interval_days: number }
      | undefined;
    if (!row) return null;

    let ease = row.ease;
    let interval = row.interval_days;
    if (quality === 1) {
      ease = Math.min(3.5, Math.max(1.3, ease * 1.1));
      interval = Math.max(1, Math.round(Math.max(1, interval) * ease));
    } else {
      ease = Math.max(1.3, ease * 0.8);
      interval = 0;
    }

    const sql =
      interval === 0
        ? `UPDATE generated_cards
             SET ease = ?, interval_days = 0,
                 next_due_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+10 minutes')
             WHERE id = ? AND user_id = ?
             RETURNING next_due_at`
        : `UPDATE generated_cards
             SET ease = ?, interval_days = ?,
                 next_due_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?)
             WHERE id = ? AND user_id = ?
             RETURNING next_due_at`;
    const params =
      interval === 0
        ? [ease, cardId, userId]
        : [ease, interval, `+${interval} day`, cardId, userId];

    const out = db.prepare(sql).get(...params) as
      | { next_due_at: string }
      | undefined;
    return out
      ? { interval_days: interval, ease, next_due_at: out.next_due_at }
      : null;
  },

  count(userId: string): { total: number; due: number } {
    const total = (
      db
        .prepare("SELECT COUNT(*) AS c FROM generated_cards WHERE user_id = ?")
        .get(userId) as { c: number }
    ).c;
    const due = (
      db
        .prepare(
          `SELECT COUNT(*) AS c FROM generated_cards
             WHERE user_id = ?
               AND (next_due_at IS NULL OR datetime(next_due_at) <= datetime('now'))`,
        )
        .get(userId) as { c: number }
    ).c;
    return { total, due };
  },
};

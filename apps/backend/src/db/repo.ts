import { randomUUID } from "node:crypto";
import { db } from "./index.js";
import type {
  DrillAttempt,
  DrillItem,
  DrillItemRow,
  GeneratedCard,
  Mode,
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
    db.prepare(
      "INSERT INTO drill_sessions (id, user_id, mode) VALUES (?, ?, ?)",
    ).run(id, userId, mode);
    return { id, user_id: userId, mode, started_at: new Date().toISOString(), ended_at: null };
  },
  end(id: string): void {
    db.prepare(
      "UPDATE drill_sessions SET ended_at = datetime('now') WHERE id = ?",
    ).run(id);
  },
  get(id: string): SessionRow | null {
    return (
      (db
        .prepare("SELECT * FROM drill_sessions WHERE id = ?")
        .get(id) as SessionRow | undefined) ?? null
    );
  },
};

export const users = {
  ensure(userId: string, displayName?: string): void {
    db.prepare(
      "INSERT OR IGNORE INTO users (id, display_name) VALUES (?, ?)",
    ).run(userId, displayName ?? null);
  },
};

export const attempts = {
  createPending(opts: {
    user_id: string;
    session_id: string;
    drill_id: string;
  }): DrillAttempt {
    const id = randomUUID();
    db.prepare(
      `INSERT INTO drill_attempts (id, user_id, session_id, drill_id)
       VALUES (?, ?, ?, ?)`,
    ).run(id, opts.user_id, opts.session_id, opts.drill_id);
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
      created_at: new Date().toISOString(),
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
         VALUES (?, ?, ?, 1, datetime('now'), ?, ?, datetime('now', '+1 day'))`,
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
             last_seen_at = datetime('now'),
             avg_score = ?,
             weakness_score = ?,
             next_due_at = datetime('now', ?)
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

export const cards = {
  insertMany(userId: string, cardsIn: GeneratedCard[]): GeneratedCard[] {
    const stmt = db.prepare(
      `INSERT INTO generated_cards
         (id, user_id, drill_id, front, back, topic, subtopic, next_due_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now', '+1 day'))`,
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
             AND (next_due_at IS NULL OR next_due_at <= datetime('now'))
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
                 next_due_at = datetime('now', '+10 minutes')
             WHERE id = ? AND user_id = ?
             RETURNING next_due_at`
        : `UPDATE generated_cards
             SET ease = ?, interval_days = ?,
                 next_due_at = datetime('now', ?)
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
               AND (next_due_at IS NULL OR next_due_at <= datetime('now'))`,
        )
        .get(userId) as { c: number }
    ).c;
    return { total, due };
  },
};

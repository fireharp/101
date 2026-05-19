import { randomUUID } from "node:crypto";
import { Router } from "express";
import type { Request, Response } from "express";
import { z } from "zod";
import YAML from "yaml";
import { importDrillsFromYaml } from "../db/seed.js";
import {
  ADMIN_AUDIT_SESSION_ID,
  attempts,
  cards,
  drills,
  events,
  sessions,
  skillState,
  usageEvents,
  users,
  type EventType,
} from "../db/repo.js";
import { selectNextDrill } from "../engines/rotation.js";
import { gradeAttempt } from "../engines/grading.js";
import {
  DRILL_COACH_INSTRUCTIONS,
  RealtimeClientSecretError,
  mintRealtimeClientSecret,
  type RealtimeTurnDetection,
} from "../services/realtime.js";
import { hasOpenAI } from "../services/llm.js";
import { config } from "../config.js";
import type { DrillAttempt, DrillItem, Mode, TokenUsage } from "../types.js";

const DEFAULT_USER_ID = "demo-user";

const modeSchema = z.enum([
  "mixed",
  "db_indexes",
  "system_design",
  "weak_topics",
  "mock_interview",
]);

function userIdFromRequest(req: Request): string {
  // MVP: single demo user. Real auth slots in here.
  return (req.header("x-user-id") ?? DEFAULT_USER_ID).trim() || DEFAULT_USER_ID;
}

export const apiRouter = Router();

/* ------------------------------------------------------------------ */
/* Health & meta                                                      */
/* ------------------------------------------------------------------ */
apiRouter.get("/health", (_req: Request, res: Response) => {
  res.json({
    ok: true,
    drills: drills.count(),
    openai_configured: hasOpenAI(),
  });
});

/* ------------------------------------------------------------------ */
/* POST /api/realtime/token                                           */
/* Mints an OpenAI Realtime ephemeral client secret.                  */
/* ------------------------------------------------------------------ */
const realtimeTokenSchema = z.object({
  voice: z.string().min(1).optional(),
  voice_speed: z.number().min(0.25).max(1.5).optional(),
  vad: z
    .object({
      mode: z.enum(["server_vad", "semantic_vad"]).default("semantic_vad"),
      threshold: z.number().min(0).max(1).default(0.5),
      prefix_padding_ms: z.number().int().min(0).max(3000).default(500),
      silence_duration_ms: z.number().int().min(100).max(5000).default(1200),
      eagerness: z.enum(["low", "medium", "high", "auto"]).default("low"),
      interrupt_response: z.boolean().default(true),
    })
    .optional(),
});

apiRouter.post("/realtime/token", async (req: Request, res: Response) => {
  const requestId = req.header("x-request-id") ?? randomUUID();
  const userId = userIdFromRequest(req);
  res.setHeader("x-request-id", requestId);
  try {
    if (!hasOpenAI()) {
      return res.status(503).json({
        error: "OPENAI_API_KEY not configured on backend",
        request_id: requestId,
      });
    }
    const parsed = realtimeTokenSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({
        error: "invalid realtime token settings",
        message: parsed.error.message,
        request_id: requestId,
      });
    }
    const vad = parsed.data.vad;
    const turnDetection: RealtimeTurnDetection | undefined = vad
      ? vad.mode === "semantic_vad"
        ? {
            type: "semantic_vad",
            eagerness: vad.eagerness,
            create_response: true,
            interrupt_response: vad.interrupt_response,
          }
        : {
            type: "server_vad",
            threshold: vad.threshold,
            prefix_padding_ms: vad.prefix_padding_ms,
            silence_duration_ms: vad.silence_duration_ms,
            create_response: true,
            interrupt_response: vad.interrupt_response,
          }
      : undefined;
    const result = await mintRealtimeClientSecret({
      instructions: DRILL_COACH_INSTRUCTIONS,
      voice: parsed.data.voice,
      voiceSpeed: parsed.data.voice_speed,
      turnDetection,
      requestId,
      userId,
    });
    res.json(result);
  } catch (err) {
    if (err instanceof RealtimeClientSecretError) {
      return res.status(502).json({
        error: "OpenAI Realtime token mint failed",
        message: err.errorInfo.message,
        request_id: requestId,
        openai_request_id: err.openaiRequestId,
        openai_status: err.upstreamStatus,
        retryable: err.retryable,
        retry_after: err.retryAfter,
        openai_error: {
          type: err.errorInfo.type,
          code: err.errorInfo.code,
          param: err.errorInfo.param,
        },
      });
    }
    console.error("[realtime] token.unhandled_error", {
      request_id: requestId,
      message: (err as Error).message,
    });
    res.status(500).json({ error: (err as Error).message, request_id: requestId });
  }
});

/* ------------------------------------------------------------------ */
/* POST /api/drill-sessions                                           */
/* Starts a drill session. Returns session id.                        */
/* ------------------------------------------------------------------ */
const createSessionSchema = z.object({
  mode: modeSchema.optional().default("mixed"),
});

apiRouter.post("/drill-sessions", (req: Request, res: Response) => {
  const userId = userIdFromRequest(req);
  const parsed = createSessionSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.message });
  }
  users.ensure(userId);
  const session = sessions.create(userId, parsed.data.mode);
  events.log(session.id, "session_created", {
    user_id: userId,
    mode: parsed.data.mode,
  });
  res.json({ session });
});

/* ------------------------------------------------------------------ */
/* GET /api/sessions                                                  */
/* Recent sessions for the current user (newest first) with rollup    */
/* stats. Drives the history panel.                                   */
/* ------------------------------------------------------------------ */
apiRouter.get("/sessions", (req: Request, res: Response) => {
  const userId = userIdFromRequest(req);
  const limit = Math.max(1, Math.min(100, Number(req.query.limit ?? 25)));
  res.json({ sessions: sessions.recent(userId, limit) });
});

/* ------------------------------------------------------------------ */
/* POST /api/drill-sessions/:id/next                                  */
/* Returns the next drill via the rotation engine.                    */
/* ------------------------------------------------------------------ */
const nextDrillSchema = z.object({
  mode: modeSchema.optional(),
  exclude_recent_count: z.number().int().min(0).max(50).optional(),
});

apiRouter.post(
  "/drill-sessions/:id/next",
  (req: Request, res: Response) => {
    const userId = userIdFromRequest(req);
    const sessionId = String(req.params.id ?? "");
    if (!sessionId) return res.status(400).json({ error: "missing id" });
    const session = sessions.get(sessionId);
    if (!session) return res.status(404).json({ error: "session not found" });
    if (session.user_id !== userId) {
      return res.status(403).json({ error: "session not owned by user" });
    }

    const parsed = nextDrillSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.message });
    }
    const mode: Mode = parsed.data.mode ?? (session.mode as Mode);
    const drill = selectNextDrill({
      user_id: userId,
      session_id: session.id,
      mode,
      exclude_recent_count: parsed.data.exclude_recent_count ?? 10,
    });
    if (!drill) return res.status(404).json({ error: "no drills available" });

    // Pre-create the attempt row so subsequent transcript/grade calls
    // can target a stable attempt id.
    const attempt = attempts.createPending({
      user_id: userId,
      session_id: session.id,
      drill_id: drill.id,
    });
    events.log(session.id, "drill_picked", {
      drill_id: drill.id,
      attempt_id: attempt.id,
      topic: drill.topic,
      subtopic: drill.subtopic,
      difficulty: drill.difficulty,
      mode,
    });

    const prior = attempts.priorForDrill(userId, drill.id, 5);
    res.json({
      drill: {
        drill_id: drill.id,
        attempt_id: attempt.id,
        question_text: drill.question_text,
        topic: drill.topic,
        subtopic: drill.subtopic,
        difficulty: drill.difficulty,
        expected_answer_shape: drill.rubric.must_have,
        rubric: drill.rubric,
        prior_attempts: prior,
      },
    });
  },
);

/* ------------------------------------------------------------------ */
/* POST /api/drill-sessions/:id/retry                                 */
/* Force a retry of a specific drill in the current session. Bypasses */
/* the rotation engine so the user can immediately re-attempt the    */
/* drill they just failed.                                            */
/* ------------------------------------------------------------------ */
const retryDrillSchema = z.object({
  drill_id: z.string().min(1),
});

apiRouter.post("/drill-sessions/:id/retry", (req: Request, res: Response) => {
  const userId = userIdFromRequest(req);
  const sessionId = String(req.params.id ?? "");
  if (!sessionId) return res.status(400).json({ error: "missing id" });
  const session = sessions.get(sessionId);
  if (!session) return res.status(404).json({ error: "session not found" });
  if (session.user_id !== userId) {
    return res.status(403).json({ error: "session not owned by user" });
  }
  const parsed = retryDrillSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.message });
  }
  const drill = drills.get(parsed.data.drill_id);
  if (!drill) return res.status(404).json({ error: "drill not found" });

  const attempt = attempts.createPending({
    user_id: userId,
    session_id: session.id,
    drill_id: drill.id,
  });
  events.log(session.id, "drill_picked", {
    drill_id: drill.id,
    attempt_id: attempt.id,
    topic: drill.topic,
    subtopic: drill.subtopic,
    difficulty: drill.difficulty,
    retry: true,
  });

  const prior = attempts.priorForDrill(userId, drill.id, 5);
  res.json({
    drill: {
      drill_id: drill.id,
      attempt_id: attempt.id,
      question_text: drill.question_text,
      topic: drill.topic,
      subtopic: drill.subtopic,
      difficulty: drill.difficulty,
      expected_answer_shape: drill.rubric.must_have,
      rubric: drill.rubric,
      prior_attempts: prior,
    },
  });
});

/* ------------------------------------------------------------------ */
/* GET /api/drill-attempts/:id                                        */
/* Full attempt detail (transcript, missed_points, ideal_answer,      */
/* created_cards). Owner-scoped — 403 for the wrong user.             */
/* ------------------------------------------------------------------ */
apiRouter.get("/drill-attempts/:id", (req: Request, res: Response) => {
  const userId = userIdFromRequest(req);
  const attemptId = String(req.params.id ?? "");
  if (!attemptId) return res.status(400).json({ error: "missing id" });
  const attempt = attempts.get(attemptId);
  if (!attempt) return res.status(404).json({ error: "attempt not found" });
  if (attempt.user_id !== userId) {
    return res.status(403).json({ error: "attempt not owned by user" });
  }
  const drill = drills.get(attempt.drill_id);
  res.json({
    attempt,
    drill: drill
      ? {
          id: drill.id,
          topic: drill.topic,
          subtopic: drill.subtopic,
          difficulty: drill.difficulty,
          question_text: drill.question_text,
          canonical_short_answer: drill.canonical_short_answer,
          rubric: drill.rubric,
        }
      : null,
  });
});

/* ------------------------------------------------------------------ */
/* POST /api/drill-attempts/:id/transcript                            */
/* Stores transcript + duration for an attempt.                       */
/* ------------------------------------------------------------------ */
const transcriptSchema = z.object({
  transcript: z.string().min(1),
  duration_seconds: z.number().int().min(0).max(1800),
});

apiRouter.post(
  "/drill-attempts/:id/transcript",
  (req: Request, res: Response) => {
    const parsed = transcriptSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.message });
    }
    const attemptId = String(req.params.id ?? "");
    if (!attemptId) return res.status(400).json({ error: "missing id" });
    const attempt = attempts.get(attemptId);
    if (!attempt) return res.status(404).json({ error: "attempt not found" });
    attempts.updateTranscript(
      attempt.id,
      parsed.data.transcript,
      parsed.data.duration_seconds,
    );
    res.json({ ok: true });
  },
);

/* ------------------------------------------------------------------ */
/* POST /api/drill-attempts/:id/grade                                 */
/* Runs the grading engine and persists everything.                   */
/* ------------------------------------------------------------------ */
const gradeSchema = z.object({
  transcript: z.string().min(1).optional(),
  duration_seconds: z.number().int().min(0).max(1800).optional(),
});

apiRouter.post(
  "/drill-attempts/:id/grade",
  async (req: Request, res: Response) => {
    const parsed = gradeSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.message });
    }
    const attemptId = String(req.params.id ?? "");
    if (!attemptId) return res.status(400).json({ error: "missing id" });
    let attempt = attempts.get(attemptId);
    if (!attempt) return res.status(404).json({ error: "attempt not found" });

    // Accept transcript inline as a convenience for the realtime tool path.
    if (parsed.data.transcript && parsed.data.duration_seconds !== undefined) {
      attempts.updateTranscript(
        attempt.id,
        parsed.data.transcript,
        parsed.data.duration_seconds,
      );
      attempt = attempts.get(attempt.id)!;
    }

    if (!attempt.transcript) {
      return res
        .status(400)
        .json({ error: "transcript missing — submit it before grading" });
    }

    const drill = drills.get(attempt.drill_id);
    if (!drill) return res.status(404).json({ error: "drill not found" });

    const grade = await gradeAttempt({
      drill,
      transcript: attempt.transcript,
      duration_seconds: attempt.duration_seconds ?? 0,
    });

    const persistedCards = cards.insertMany(attempt.user_id, grade.cards);

    attempts.updateGrade(attempt.id, {
      score: grade.score,
      verdict: grade.verdict,
      missed_points: grade.missed_points,
      ideal_answer: grade.ideal_short_answer,
      created_cards: persistedCards,
    });

    skillState.upsertAfterAttempt({
      user_id: attempt.user_id,
      topic: drill.topic,
      subtopic: drill.subtopic,
      score: grade.score,
    });

    events.log(attempt.session_id, "grade_completed", {
      attempt_id: attempt.id,
      drill_id: drill.id,
      score: grade.score,
      verdict: grade.verdict,
      missed_count: grade.missed_points.length,
      cards_generated: persistedCards.length,
    });
    recordGradingUsage(attempt, drill, grade.usage);

    res.json({
      attempt_id: attempt.id,
      score: grade.score,
      verdict: grade.verdict,
      missed_points: grade.missed_points,
      ideal_short_answer: grade.ideal_short_answer,
      cards: persistedCards,
      breakdown: grade.breakdown,
    });
  },
);

function buildSessionSummary(
  userId: string,
  session: {
    id: string;
    mode: Mode;
    started_at: string;
    ended_at: string | null;
  },
) {
  const sessionAttempts = attempts.listForSession(session.id);
  const graded = sessionAttempts.filter((a) => a.score !== null);
  const avg =
    graded.length > 0
      ? graded.reduce((s, a) => s + (a.score ?? 0), 0) / graded.length
      : 0;

  const topicSet = new Set<string>();
  const itemRows = sessionAttempts.map((a) => {
    const drill = drills.get(a.drill_id);
    if (drill) topicSet.add(drill.topic);
    return {
      attempt_id: a.id,
      drill_id: a.drill_id,
      topic: drill?.topic ?? null,
      subtopic: drill?.subtopic ?? null,
      score: a.score,
      verdict: a.verdict,
      duration_seconds: a.duration_seconds,
      usage: usageEvents.totalsForAttempt(a.id),
    };
  });

  return {
    session_id: session.id,
    mode: session.mode,
    started_at: session.started_at,
    ended_at: session.ended_at,
    drills_attempted: sessionAttempts.length,
    drills_graded: graded.length,
    average_score: Math.round(avg * 1000) / 1000,
    passes: graded.filter((a) => a.verdict === "pass").length,
    borderlines: graded.filter((a) => a.verdict === "borderline").length,
    fails: graded.filter((a) => a.verdict === "fail").length,
    topics_covered: [...topicSet],
    usage: usageEvents.totalsForSession(userId, session.id),
    weakness_after: skillState
      .getAll(userId)
      .sort((a, b) => b.weakness_score - a.weakness_score),
    attempts: itemRows,
  };
}

function recordGradingUsage(
  attempt: DrillAttempt,
  drill: DrillItem,
  usage: TokenUsage | undefined,
): void {
  if (!usage || usage.total_tokens <= 0) return;
  usageEvents.record({
    ...usage,
    user_id: attempt.user_id,
    session_id: attempt.session_id,
    attempt_id: attempt.id,
    drill_id: drill.id,
    source: "chat_grading",
    model: usage.model ?? config.gradingModel,
    response_id: usage.response_id ?? null,
    estimated_cost_usd: usage.estimated_cost_usd ?? null,
  });
}

/* ------------------------------------------------------------------ */
/* GET /api/drill-sessions/:id/summary                                */
/* End-of-session stats: drills attempted, average score, topics      */
/* covered, weakness state snapshot.                                  */
/* ------------------------------------------------------------------ */
apiRouter.get(
  "/drill-sessions/:id/summary",
  (req: Request, res: Response) => {
    const userId = userIdFromRequest(req);
    const sessionId = String(req.params.id ?? "");
    if (!sessionId) return res.status(400).json({ error: "missing id" });
    const session = sessions.get(sessionId);
    if (!session) return res.status(404).json({ error: "session not found" });
    if (session.user_id !== userId) {
      return res.status(403).json({ error: "session not owned by user" });
    }
    res.json(buildSessionSummary(userId, session));
  },
);

/* ------------------------------------------------------------------ */
/* POST /api/drill-sessions/:id/end                                   */
/* Marks the session ended_at and returns the same summary.           */
/* ------------------------------------------------------------------ */
apiRouter.post("/drill-sessions/:id/end", (req: Request, res: Response) => {
  const userId = userIdFromRequest(req);
  const sessionId = String(req.params.id ?? "");
  if (!sessionId) return res.status(400).json({ error: "missing id" });
  const session = sessions.get(sessionId);
  if (!session) return res.status(404).json({ error: "session not found" });
  if (session.user_id !== userId) {
    return res.status(403).json({ error: "session not owned by user" });
  }
  sessions.end(session.id);
  const ended = sessions.get(session.id) ?? { ...session, ended_at: new Date().toISOString() };
  const summary = buildSessionSummary(userId, ended);
  events.log(session.id, "session_ended", {
    drills_attempted: summary.drills_attempted,
    drills_graded: summary.drills_graded,
    average_score: summary.average_score,
    passes: summary.passes,
    borderlines: summary.borderlines,
    fails: summary.fails,
  });
  res.json(summary);
});

/* ------------------------------------------------------------------ */
/* GET /api/drill-sessions/:id/events                                 */
/* LOCAL.md §7 audit log: returns all session_events for the session  */
/* in insertion order. Owner-scoped.                                  */
/* ------------------------------------------------------------------ */
apiRouter.get("/drill-sessions/:id/events", (req: Request, res: Response) => {
  const userId = userIdFromRequest(req);
  const sessionId = String(req.params.id ?? "");
  if (!sessionId) return res.status(400).json({ error: "missing id" });
  const session = sessions.get(sessionId);
  if (!session) return res.status(404).json({ error: "session not found" });
  if (session.user_id !== userId) {
    return res.status(403).json({ error: "session not owned by user" });
  }
  res.json({ events: events.listForSession(session.id) });
});

/* ------------------------------------------------------------------ */
/* POST /api/realtime/usage                                           */
/* Stores token usage observed by the browser Realtime data channel.  */
/* ------------------------------------------------------------------ */
const tokenUsageSchema = z.object({
  model: z.string().min(1).nullable().optional(),
  response_id: z.string().min(1).nullable().optional(),
  input_tokens: z.number().int().min(0).default(0),
  output_tokens: z.number().int().min(0).default(0),
  total_tokens: z.number().int().min(0).default(0),
  input_text_tokens: z.number().int().min(0).default(0),
  input_audio_tokens: z.number().int().min(0).default(0),
  cached_tokens: z.number().int().min(0).default(0),
  output_text_tokens: z.number().int().min(0).default(0),
  output_audio_tokens: z.number().int().min(0).default(0),
  estimated_cost_usd: z.number().min(0).nullable().optional(),
  raw_usage: z.record(z.string(), z.unknown()).optional(),
});

const realtimeUsageSchema = z.object({
  session_id: z.string().min(1),
  attempt_id: z.string().min(1).optional(),
  drill_id: z.string().min(1).optional(),
  source: z.enum(["realtime_response", "realtime_transcription"]),
  model: z.string().min(1).nullable().optional(),
  response_id: z.string().min(1).nullable().optional(),
  usage: tokenUsageSchema,
});

apiRouter.post("/realtime/usage", (req: Request, res: Response) => {
  const parsed = realtimeUsageSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.message });
  }
  const userId = userIdFromRequest(req);
  const session = sessions.get(parsed.data.session_id);
  if (!session) return res.status(404).json({ error: "session not found" });
  if (session.user_id !== userId) {
    return res.status(403).json({ error: "session not owned by user" });
  }

  let attempt: DrillAttempt | null = null;
  if (parsed.data.attempt_id) {
    attempt = attempts.get(parsed.data.attempt_id);
    if (!attempt) return res.status(404).json({ error: "attempt not found" });
    if (attempt.user_id !== userId || attempt.session_id !== session.id) {
      return res.status(403).json({ error: "attempt not owned by session" });
    }
    if (parsed.data.drill_id && parsed.data.drill_id !== attempt.drill_id) {
      return res.status(400).json({ error: "drill_id does not match attempt" });
    }
  }

  const u = parsed.data.usage;
  usageEvents.record({
    ...u,
    user_id: userId,
    session_id: session.id,
    attempt_id: attempt?.id ?? parsed.data.attempt_id ?? null,
    drill_id: attempt?.drill_id ?? parsed.data.drill_id ?? null,
    source: parsed.data.source,
    model: parsed.data.model ?? u.model ?? null,
    response_id: parsed.data.response_id ?? u.response_id ?? null,
    estimated_cost_usd: u.estimated_cost_usd ?? null,
  });

  res.json({
    ok: true,
    session: usageEvents.totalsForSession(userId, session.id),
  });
});

/* ------------------------------------------------------------------ */
/* GET /api/usage/summary                                             */
/* Aggregates usage for the current user and optional session.         */
/* ------------------------------------------------------------------ */
apiRouter.get("/usage/summary", (req: Request, res: Response) => {
  const userId = userIdFromRequest(req);
  const sessionId =
    typeof req.query.session_id === "string" ? req.query.session_id : undefined;
  if (sessionId) {
    const session = sessions.get(sessionId);
    if (!session) return res.status(404).json({ error: "session not found" });
    if (session.user_id !== userId) {
      return res.status(403).json({ error: "session not owned by user" });
    }
  }
  res.json({
    total: usageEvents.totalsForUser(userId),
    session: sessionId ? usageEvents.totalsForSession(userId, sessionId) : null,
    by_source: usageEvents.bySource(userId, sessionId),
    by_attempt: sessionId
      ? usageEvents.byAttemptForSession(userId, sessionId)
      : [],
  });
});

/* ------------------------------------------------------------------ */
/* GET /api/cards/due                                                 */
/* ------------------------------------------------------------------ */
apiRouter.get("/cards/due", (req: Request, res: Response) => {
  const userId = userIdFromRequest(req);
  const limit = Number(req.query.limit ?? 20);
  res.json({ cards: cards.due(userId, limit), stats: cards.count(userId) });
});

/* ------------------------------------------------------------------ */
/* POST /api/cards/:id/review                                         */
/* Records SM-2-lite review feedback. quality: 0 (forgot) | 1 (knew)  */
/* ------------------------------------------------------------------ */
const cardReviewSchema = z.object({
  quality: z.union([z.literal(0), z.literal(1)]),
});

/* ------------------------------------------------------------------ */
/* GET /api/cards/export.csv                                          */
/* Anki-importable CSV. Columns: front, back, tags.                   */
/* ------------------------------------------------------------------ */
apiRouter.get("/cards/export.csv", (req: Request, res: Response) => {
  const userId = userIdFromRequest(req);
  const all = cards.all(userId);
  const escape = (s: string) =>
    /[,"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  const lines = ["front,back,tags"];
  for (const c of all) {
    const tags = [c.topic, c.subtopic].filter(Boolean).join(" ");
    lines.push(
      [escape(c.front), escape(c.back), escape(tags)].join(","),
    );
  }
  res.setHeader("content-type", "text/csv; charset=utf-8");
  res.setHeader(
    "content-disposition",
    `attachment; filename="drill-coach-cards.csv"`,
  );
  res.send(lines.join("\n") + "\n");
});

apiRouter.post("/cards/:id/review", (req: Request, res: Response) => {
  const userId = userIdFromRequest(req);
  const cardId = String(req.params.id ?? "");
  if (!cardId) return res.status(400).json({ error: "missing id" });
  const parsed = cardReviewSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.message });
  }
  const result = cards.review(userId, cardId, parsed.data.quality);
  if (!result) return res.status(404).json({ error: "card not found" });
  res.json({ ok: true, ...result });
});

/* ------------------------------------------------------------------ */
/* GET /api/progress                                                  */
/* ------------------------------------------------------------------ */
apiRouter.get("/progress", (req: Request, res: Response) => {
  const userId = userIdFromRequest(req);
  const state = skillState.getAll(userId);
  res.json({
    user_id: userId,
    skills: state.sort((a, b) => b.weakness_score - a.weakness_score),
  });
});

/* ------------------------------------------------------------------ */
/* GET /api/progress/drills                                           */
/* Per-drill performance for the current user (lowest avg first), so  */
/* the UI can show which specific drills consistently underperform.   */
/* ------------------------------------------------------------------ */
apiRouter.get("/progress/drills", (req: Request, res: Response) => {
  const userId = userIdFromRequest(req);
  const limit = Math.max(1, Math.min(200, Number(req.query.limit ?? 50)));
  res.json({ drills: attempts.performanceByDrill(userId, limit) });
});

/* ------------------------------------------------------------------ */
/* GET /api/drills                                                    */
/* Browse/admin view of the drill bank.                               */
/* ------------------------------------------------------------------ */
apiRouter.get("/drills", (req: Request, res: Response) => {
  const items = drills.list({
    topic: typeof req.query.topic === "string" ? req.query.topic : undefined,
    active: true,
  });
  res.json({ count: items.length, drills: items });
});

/* ------------------------------------------------------------------ */
/* GET /api/drills/drafts                                             */
/* Lists is_active=false drills (Layer-3 LLM drafts).                 */
/* ------------------------------------------------------------------ */
apiRouter.get("/drills/drafts", (_req: Request, res: Response) => {
  const items = drills.listDrafts();
  res.json({ count: items.length, drills: items });
});

/* ------------------------------------------------------------------ */
/* GET /api/stats                                                     */
/* Drill bank distribution (active vs draft, by topic / difficulty /  */
/* trap_type) so content authors can spot coverage gaps.              */
/* ------------------------------------------------------------------ */
apiRouter.get("/stats", (_req: Request, res: Response) => {
  res.json(drills.stats());
});

/* ------------------------------------------------------------------ */
/* POST /api/drills/import                                            */
/* Bulk-imports drills from YAML. Accepts either:                     */
/*   - Content-Type: application/x-yaml | text/yaml (raw body), or    */
/*   - Content-Type: application/json with `{ yaml: "..." }`.         */
/* Validates each entry with the same Zod schema as the seed loader.  */
/* Returns { ok, imported, skipped: [{ id?, error }] }.               */
/* ------------------------------------------------------------------ */
apiRouter.post("/drills/import", (req: Request, res: Response) => {
  let yamlText = "";
  if (typeof req.body === "string") {
    yamlText = req.body;
  } else if (
    req.body &&
    typeof req.body === "object" &&
    typeof (req.body as { yaml?: unknown }).yaml === "string"
  ) {
    yamlText = (req.body as { yaml: string }).yaml;
  }
  if (!yamlText.trim()) {
    return res
      .status(400)
      .json({ error: "send YAML body or JSON { yaml: '...' }" });
  }
  const result = importDrillsFromYaml(yamlText);
  events.log(ADMIN_AUDIT_SESSION_ID, "drill_imported", {
    imported: result.imported,
    skipped: result.skipped.length,
  });
  res.status(result.ok ? 200 : 207).json(result);
});

/* ------------------------------------------------------------------ */
/* GET /api/drills/export.yaml                                        */
/* Dumps the active drill bank (and optionally drafts) as YAML in     */
/* the same shape as the LOCAL.md §16 seed format. Round-trips with   */
/* seeds/drills/*.yaml so users can edit rubrics in-app, export, and  */
/* check the result into git.                                         */
/* ------------------------------------------------------------------ */
apiRouter.get("/drills/export.yaml", (req: Request, res: Response) => {
  const includeDrafts = req.query.include_drafts === "1";
  const active = drills.list({ active: true });
  const items = includeDrafts ? [...active, ...drills.listDrafts()] : active;
  const seedFormat = items.map((d) => ({
    id: d.id,
    topic: d.topic,
    subtopic: d.subtopic,
    difficulty: d.difficulty,
    trap_type: d.trap_type,
    question_text: d.question_text,
    expected_answer: d.expected_answer,
    rubric: d.rubric,
    canonical_short_answer: d.canonical_short_answer,
    canonical_deep_answer: d.canonical_deep_answer,
    tags: d.tags,
    is_active: d.is_active,
  }));
  const body = YAML.stringify(seedFormat, { lineWidth: 0 });
  res.setHeader("content-type", "application/x-yaml; charset=utf-8");
  res.setHeader(
    "content-disposition",
    `attachment; filename="drill-bank${includeDrafts ? "-with-drafts" : ""}.yaml"`,
  );
  res.send(body);
});

/* ------------------------------------------------------------------ */
/* POST /api/drills/:id/activate                                      */
/* Promotes a draft into the rotation pool.                           */
/* ------------------------------------------------------------------ */
apiRouter.post("/drills/:id/activate", (req: Request, res: Response) => {
  const id = String(req.params.id ?? "");
  if (!id) return res.status(400).json({ error: "missing id" });
  const ok = drills.setActive(id, true);
  if (!ok) return res.status(404).json({ error: "drill not found" });
  const drill = drills.get(id);
  events.log(ADMIN_AUDIT_SESSION_ID, "draft_activated", { drill_id: id });
  res.json({ ok: true, drill });
});

/* ------------------------------------------------------------------ */
/* POST /api/drills/:id/deactivate                                    */
/* Pulls a drill out of the rotation pool (is_active=false). Mirror   */
/* of activate so the admin loop is symmetric: active ↔ draft, then   */
/* DELETE if the user wants it gone for good.                         */
/* ------------------------------------------------------------------ */
apiRouter.post("/drills/:id/deactivate", (req: Request, res: Response) => {
  const id = String(req.params.id ?? "");
  if (!id) return res.status(400).json({ error: "missing id" });
  const ok = drills.setActive(id, false);
  if (!ok) return res.status(404).json({ error: "drill not found" });
  const drill = drills.get(id);
  events.log(ADMIN_AUDIT_SESSION_ID, "draft_deactivated", { drill_id: id });
  res.json({ ok: true, drill });
});

/* ------------------------------------------------------------------ */
/* DELETE /api/drills/:id                                             */
/* Only allowed on inactive drafts to prevent destroying live data.   */
/* ------------------------------------------------------------------ */
apiRouter.delete("/drills/:id", (req: Request, res: Response) => {
  const id = String(req.params.id ?? "");
  if (!id) return res.status(400).json({ error: "missing id" });
  const existing = drills.get(id);
  if (!existing) return res.status(404).json({ error: "drill not found" });
  if (existing.is_active) {
    return res.status(409).json({
      error: "drill is active — only inactive drafts can be deleted",
    });
  }
  const ok = drills.remove(id, true);
  if (ok) events.log(ADMIN_AUDIT_SESSION_ID, "draft_discarded", { drill_id: id });
  res.json({ ok });
});

/* ------------------------------------------------------------------ */
/* PATCH /api/drills/:id                                              */
/* Inline rubric editor (LOCAL.md §13 admin). Allows updating         */
/* question_text, rubric, canonical answers, difficulty, trap_type,   */
/* tags. is_active is intentionally NOT editable here — use the       */
/* activate/delete endpoints.                                         */
/* ------------------------------------------------------------------ */
const rubricPatchSchema = z.object({
  // must_have is the heart of the rubric — at least one item required.
  must_have: z.array(z.string().min(1)).min(1),
  nice_to_have: z.array(z.string()),
  red_flags: z.array(z.string()),
});
const drillPatchSchema = z.object({
  question_text: z.string().min(10).optional(),
  canonical_short_answer: z.string().min(10).optional(),
  canonical_deep_answer: z.string().nullable().optional(),
  difficulty: z.number().int().min(1).max(5).optional(),
  trap_type: z.string().nullable().optional(),
  rubric: rubricPatchSchema.optional(),
  tags: z.array(z.string()).optional(),
});

apiRouter.patch("/drills/:id", (req: Request, res: Response) => {
  const id = String(req.params.id ?? "");
  if (!id) return res.status(400).json({ error: "missing id" });
  const parsed = drillPatchSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.message });
  }
  const updated = drills.patch(id, parsed.data);
  if (!updated) return res.status(404).json({ error: "drill not found" });
  events.log(ADMIN_AUDIT_SESSION_ID, "rubric_edited", {
    drill_id: id,
    fields_changed: Object.keys(parsed.data),
  });
  res.json({ ok: true, drill: updated });
});

/* ------------------------------------------------------------------ */
/* GET /api/admin/events                                              */
/* Surfaces the admin-only audit trail (drill imports, draft state    */
/* changes, rubric edits). Backs the LOCAL.md §13 admin loop so       */
/* changes to the drill bank are reviewable.                          */
/* ------------------------------------------------------------------ */
const ADMIN_EVENT_TYPES = new Set<string>([
  "drill_imported",
  "draft_activated",
  "draft_deactivated",
  "draft_discarded",
  "rubric_edited",
]);

apiRouter.get("/admin/events", (req: Request, res: Response) => {
  const limitRaw = Number(req.query.limit ?? 100);
  const limit = Number.isFinite(limitRaw)
    ? Math.max(1, Math.min(500, Math.floor(limitRaw)))
    : 100;

  const typeParam = req.query.type;
  let types: EventType[] | undefined;
  if (typeof typeParam === "string" && typeParam.length > 0) {
    const requested = typeParam.split(",").map((s) => s.trim()).filter(Boolean);
    const invalid = requested.filter((t) => !ADMIN_EVENT_TYPES.has(t));
    if (invalid.length > 0) {
      return res.status(400).json({
        error: `unknown event type(s): ${invalid.join(", ")}`,
        allowed: [...ADMIN_EVENT_TYPES],
      });
    }
    types = requested as EventType[];
  }

  let sinceIso: string | undefined;
  if (typeof req.query.since === "string" && req.query.since.length > 0) {
    const parsed = new Date(req.query.since);
    if (Number.isNaN(parsed.getTime())) {
      return res.status(400).json({
        error: `invalid 'since' — expected ISO 8601, got '${req.query.since}'`,
      });
    }
    sinceIso = parsed.toISOString();
  }

  res.json({ events: events.listAdmin({ limit, types, sinceIso }) });
});

/* ------------------------------------------------------------------ */
/* POST /api/drills/:id/test-grade                                    */
/* Runs the grading engine against a sample transcript WITHOUT        */
/* persisting an attempt or updating skill state. For rubric tuning   */
/* (LOCAL.md §13 admin screen).                                       */
/* ------------------------------------------------------------------ */
const testGradeSchema = z.object({
  transcript: z.string().min(1),
  duration_seconds: z.number().int().min(0).max(1800).optional().default(45),
});

apiRouter.post(
  "/drills/:id/test-grade",
  async (req: Request, res: Response) => {
    const id = String(req.params.id ?? "");
    if (!id) return res.status(400).json({ error: "missing id" });
    const drill = drills.get(id);
    if (!drill) return res.status(404).json({ error: "drill not found" });
    const parsed = testGradeSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.message });
    }
    const grade = await gradeAttempt({
      drill,
      transcript: parsed.data.transcript,
      duration_seconds: parsed.data.duration_seconds,
    });
    // Do NOT persist anything — this is a dry-run for rubric tuning.
    res.json({
      drill_id: drill.id,
      score: grade.score,
      verdict: grade.verdict,
      missed_points: grade.missed_points,
      ideal_short_answer: grade.ideal_short_answer,
      breakdown: grade.breakdown,
      cards: grade.cards.map((c) => ({ front: c.front, back: c.back })),
    });
  },
);

/* ------------------------------------------------------------------ */
/* POST /api/realtime/tool-call                                       */
/* Single dispatch endpoint for the Realtime voice agent.             */
/* The frontend forwards function_call_arguments.done events here,    */
/* turns the result into a function_call_output and sends it back     */
/* over the data channel. Keeps tool-handling logic out of the        */
/* browser.                                                           */
/* ------------------------------------------------------------------ */
const toolCallSchema = z.object({
  session_id: z.string().min(1),
  attempt_id: z.string().min(1).optional(),
  name: z.enum([
    "get_next_drill",
    "submit_answer_transcript",
    "grade_attempt",
    "save_generated_cards",
    "get_user_skill_summary",
    "end_session_summary",
  ]),
  arguments: z.record(z.string(), z.unknown()).default({}),
});

apiRouter.post("/realtime/tool-call", async (req: Request, res: Response) => {
  const parsed = toolCallSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.message });
  }
  const userId = userIdFromRequest(req);
  const session = sessions.get(parsed.data.session_id);
  if (!session) return res.status(404).json({ error: "session not found" });
  if (session.user_id !== userId) {
    return res.status(403).json({ error: "session not owned by user" });
  }

  const args = parsed.data.arguments;

  try {
    switch (parsed.data.name) {
      case "get_next_drill": {
        const mode = (typeof args.mode === "string" ? args.mode : session.mode) as Mode;
        const drill = selectNextDrill({
          user_id: userId,
          session_id: session.id,
          mode,
          exclude_recent_count: 10,
        });
        if (!drill) {
          return res.json({
            result: { error: "no drills available" },
          });
        }
        const attempt = attempts.createPending({
          user_id: userId,
          session_id: session.id,
          drill_id: drill.id,
        });
        return res.json({
          result: {
            attempt_id: attempt.id,
            drill_id: drill.id,
            topic: drill.topic,
            subtopic: drill.subtopic,
            difficulty: drill.difficulty,
            question_text: drill.question_text.trim(),
            expected_answer_shape: drill.rubric.must_have,
            // Strip rubric details so the model still has to grade against
            // the user's answer — it should not auto-leak the cheat sheet
            // before the user attempts. The host app receives full rubric
            // via the React state pipe.
          },
        });
      }

      case "submit_answer_transcript": {
        const attemptId = String(args.attempt_id ?? parsed.data.attempt_id ?? "");
        const transcript = String(args.transcript ?? "");
        const duration = Number(args.duration_seconds ?? 0);
        if (!attemptId) return res.json({ result: { error: "attempt_id required" } });
        const attempt = attempts.get(attemptId);
        if (!attempt) return res.json({ result: { error: "attempt not found" } });
        attempts.updateTranscript(attempt.id, transcript, duration);
        return res.json({ result: { ok: true } });
      }

      case "grade_attempt": {
        const attemptId = String(args.attempt_id ?? parsed.data.attempt_id ?? "");
        if (!attemptId) return res.json({ result: { error: "attempt_id required" } });
        let attempt = attempts.get(attemptId);
        if (!attempt) return res.json({ result: { error: "attempt not found" } });

        if (typeof args.transcript === "string" && args.duration_seconds !== undefined) {
          attempts.updateTranscript(
            attempt.id,
            String(args.transcript),
            Number(args.duration_seconds),
          );
          attempt = attempts.get(attempt.id)!;
        }
        if (!attempt.transcript) {
          return res.json({
            result: { error: "transcript missing — call submit_answer_transcript first" },
          });
        }
        const drill = drills.get(attempt.drill_id);
        if (!drill) return res.json({ result: { error: "drill not found" } });
        const grade = await gradeAttempt({
          drill,
          transcript: attempt.transcript,
          duration_seconds: attempt.duration_seconds ?? 0,
        });
        const persistedCards = cards.insertMany(attempt.user_id, grade.cards);
        attempts.updateGrade(attempt.id, {
          score: grade.score,
          verdict: grade.verdict,
          missed_points: grade.missed_points,
          ideal_answer: grade.ideal_short_answer,
          created_cards: persistedCards,
        });
        skillState.upsertAfterAttempt({
          user_id: attempt.user_id,
          topic: drill.topic,
          subtopic: drill.subtopic,
          score: grade.score,
        });
        recordGradingUsage(attempt, drill, grade.usage);
        return res.json({
          result: {
            attempt_id: attempt.id,
            score: grade.score,
            verdict: grade.verdict,
            missed_points: grade.missed_points,
            ideal_short_answer: grade.ideal_short_answer,
            cards: persistedCards.map((c) => ({ front: c.front, back: c.back })),
          },
        });
      }

      case "save_generated_cards": {
        const cardsIn = Array.isArray(args.cards) ? args.cards : [];
        const saved = cards.insertMany(
          userId,
          cardsIn
            .filter(
              (c): c is { front: string; back: string; drill_id?: string } =>
                typeof c === "object" &&
                c !== null &&
                typeof (c as { front?: unknown }).front === "string" &&
                typeof (c as { back?: unknown }).back === "string",
            )
            .map((c) => ({
              front: c.front,
              back: c.back,
              drill_id: c.drill_id,
            })),
        );
        return res.json({ result: { saved: saved.length } });
      }

      case "get_user_skill_summary": {
        const state = skillState.getAll(userId);
        return res.json({
          result: {
            weakest: state
              .sort((a, b) => b.weakness_score - a.weakness_score)
              .slice(0, 5)
              .map((s) => ({
                topic: s.topic,
                subtopic: s.subtopic,
                weakness_score: s.weakness_score,
                exposure_count: s.exposure_count,
              })),
          },
        });
      }

      case "end_session_summary": {
        sessions.end(session.id);
        const sessionAttempts = attempts.listForSession(session.id);
        const graded = sessionAttempts.filter((a) => a.score !== null);
        const avg =
          graded.length > 0
            ? graded.reduce((s, a) => s + (a.score ?? 0), 0) / graded.length
            : 0;
        return res.json({
          result: {
            drills_attempted: sessionAttempts.length,
            average_score: Math.round(avg * 1000) / 1000,
            passes: graded.filter((a) => a.verdict === "pass").length,
            borderlines: graded.filter((a) => a.verdict === "borderline").length,
            fails: graded.filter((a) => a.verdict === "fail").length,
          },
        });
      }
    }
  } catch (err) {
    return res
      .status(500)
      .json({ result: { error: (err as Error).message } });
  }
});

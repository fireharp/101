import { Router } from "express";
import type { Request, Response } from "express";
import { z } from "zod";
import {
  attempts,
  cards,
  drills,
  sessions,
  skillState,
  users,
} from "../db/repo.js";
import { selectNextDrill } from "../engines/rotation.js";
import { gradeAttempt } from "../engines/grading.js";
import {
  DRILL_COACH_INSTRUCTIONS,
  mintRealtimeClientSecret,
} from "../services/realtime.js";
import { hasOpenAI } from "../services/llm.js";
import type { Mode } from "../types.js";

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
apiRouter.post("/realtime/token", async (req: Request, res: Response) => {
  try {
    if (!hasOpenAI()) {
      return res.status(503).json({
        error: "OPENAI_API_KEY not configured on backend",
      });
    }
    const voice =
      typeof req.body?.voice === "string" ? (req.body.voice as string) : undefined;
    const result = await mintRealtimeClientSecret({
      instructions: DRILL_COACH_INSTRUCTIONS,
      voice,
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
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
  res.json({ session });
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
      },
    });
  },
);

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

/* ------------------------------------------------------------------ */
/* GET /api/cards/due                                                 */
/* ------------------------------------------------------------------ */
apiRouter.get("/cards/due", (req: Request, res: Response) => {
  const userId = userIdFromRequest(req);
  const limit = Number(req.query.limit ?? 20);
  res.json({ cards: cards.due(userId, limit) });
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

export type Mode =
  | "mixed"
  | "db_indexes"
  | "system_design"
  | "weak_topics"
  | "mock_interview";

export interface DrillPayload {
  drill_id: string;
  attempt_id: string;
  question_text: string;
  topic: string;
  subtopic: string;
  difficulty: number;
  expected_answer_shape: string[];
  rubric: {
    must_have: string[];
    nice_to_have: string[];
    red_flags: string[];
  };
  prior_attempts?: {
    score: number;
    verdict: string | null;
    created_at: string;
  }[];
}

export interface SessionSummary {
  session_id: string;
  mode: Mode;
  started_at: string;
  ended_at: string | null;
  drills_attempted: number;
  drills_graded: number;
  average_score: number;
  passes: number;
  borderlines: number;
  fails: number;
  topics_covered: string[];
  weakness_after: {
    topic: string;
    subtopic: string;
    weakness_score: number;
    exposure_count: number;
  }[];
  attempts: {
    attempt_id: string;
    drill_id: string;
    topic: string | null;
    subtopic: string | null;
    score: number | null;
    verdict: string | null;
    duration_seconds: number | null;
  }[];
}

export interface SessionPayload {
  id: string;
  user_id: string;
  mode: Mode;
}

export interface GradeResult {
  attempt_id: string;
  score: number;
  verdict: "pass" | "borderline" | "fail";
  missed_points: string[];
  ideal_short_answer: string;
  cards: { id?: string; front: string; back: string }[];
  breakdown: {
    must_have_coverage: number;
    answer_clarity: number;
    tradeoff_coverage: number;
    speed_score: number;
    red_flag_penalty: number;
  };
}

export interface RealtimeToken {
  client_secret: string;
  expires_at: number;
  model: string;
  session_id: string | null;
  voice: string;
}

async function jsonFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${res.status} ${res.statusText}: ${text || path}`);
  }
  return (await res.json()) as T;
}

export const api = {
  health: () =>
    jsonFetch<{ ok: boolean; drills: number; openai_configured: boolean }>(
      "/api/health",
    ),

  startSession: (mode: Mode) =>
    jsonFetch<{ session: SessionPayload }>("/api/drill-sessions", {
      method: "POST",
      body: JSON.stringify({ mode }),
    }).then((r) => r.session),

  nextDrill: (sessionId: string, mode?: Mode) =>
    jsonFetch<{ drill: DrillPayload }>(
      `/api/drill-sessions/${sessionId}/next`,
      {
        method: "POST",
        body: JSON.stringify(mode ? { mode } : {}),
      },
    ).then((r) => r.drill),

  submitTranscript: (
    attemptId: string,
    transcript: string,
    durationSeconds: number,
  ) =>
    jsonFetch<{ ok: boolean }>(
      `/api/drill-attempts/${attemptId}/transcript`,
      {
        method: "POST",
        body: JSON.stringify({
          transcript,
          duration_seconds: durationSeconds,
        }),
      },
    ),

  grade: (attemptId: string, transcript: string, durationSeconds: number) =>
    jsonFetch<GradeResult>(`/api/drill-attempts/${attemptId}/grade`, {
      method: "POST",
      body: JSON.stringify({
        transcript,
        duration_seconds: durationSeconds,
      }),
    }),

  realtimeToken: () =>
    jsonFetch<RealtimeToken>("/api/realtime/token", {
      method: "POST",
      body: "{}",
    }),

  progress: () =>
    jsonFetch<{
      skills: {
        topic: string;
        subtopic: string;
        weakness_score: number;
        avg_score: number | null;
        exposure_count: number;
      }[];
    }>("/api/progress"),

  cardsDue: (limit = 20) =>
    jsonFetch<{
      cards: {
        id: string;
        front: string;
        back: string;
        topic: string | null;
        subtopic: string | null;
        next_due_at: string | null;
      }[];
      stats: { total: number; due: number };
    }>(`/api/cards/due?limit=${limit}`),

  reviewCard: (cardId: string, quality: 0 | 1) =>
    jsonFetch<{
      ok: boolean;
      interval_days: number;
      ease: number;
      next_due_at: string;
    }>(`/api/cards/${cardId}/review`, {
      method: "POST",
      body: JSON.stringify({ quality }),
    }),

  sessionSummary: (sessionId: string) =>
    jsonFetch<SessionSummary>(`/api/drill-sessions/${sessionId}/summary`),

  endSession: (sessionId: string) =>
    jsonFetch<SessionSummary>(`/api/drill-sessions/${sessionId}/end`, {
      method: "POST",
    }),

  drafts: () =>
    jsonFetch<{
      count: number;
      drills: {
        id: string;
        topic: string;
        subtopic: string;
        difficulty: number;
        trap_type: string | null;
        question_text: string;
        canonical_short_answer: string;
        rubric: {
          must_have: string[];
          nice_to_have: string[];
          red_flags: string[];
        };
        tags: string[];
      }[];
    }>("/api/drills/drafts"),

  activateDrill: (id: string) =>
    jsonFetch<{ ok: boolean }>(`/api/drills/${id}/activate`, {
      method: "POST",
      body: "{}",
    }),

  deleteDrill: (id: string) =>
    jsonFetch<{ ok: boolean }>(`/api/drills/${id}`, {
      method: "DELETE",
    }),

  testGrade: (id: string, transcript: string, durationSeconds = 45) =>
    jsonFetch<{
      drill_id: string;
      score: number;
      verdict: "pass" | "borderline" | "fail";
      missed_points: string[];
      ideal_short_answer: string;
      breakdown: {
        must_have_coverage: number;
        answer_clarity: number;
        tradeoff_coverage: number;
        speed_score: number;
        red_flag_penalty: number;
      };
      cards: { front: string; back: string }[];
    }>(`/api/drills/${id}/test-grade`, {
      method: "POST",
      body: JSON.stringify({
        transcript,
        duration_seconds: durationSeconds,
      }),
    }),

  drills: (topic?: string) =>
    jsonFetch<{
      count: number;
      drills: {
        id: string;
        topic: string;
        subtopic: string;
        difficulty: number;
        trap_type: string | null;
        question_text: string;
        canonical_short_answer: string;
        rubric: {
          must_have: string[];
          nice_to_have: string[];
          red_flags: string[];
        };
        tags: string[];
      }[];
    }>(`/api/drills${topic ? `?topic=${encodeURIComponent(topic)}` : ""}`),

  toolCall: (
    sessionId: string,
    name: string,
    args: Record<string, unknown>,
    userId?: string,
  ) =>
    jsonFetch<{ result: Record<string, unknown> }>("/api/realtime/tool-call", {
      method: "POST",
      headers: userId ? { "x-user-id": userId } : {},
      body: JSON.stringify({
        session_id: sessionId,
        name,
        arguments: args,
      }),
    }).then((r) => r.result),
};

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
};

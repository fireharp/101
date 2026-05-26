export type Mode =
  | "mixed"
  | "db_indexes"
  | "system_design"
  | "weak_topics"
  | "mock_interview"
  | "rapid_fundamentals"
  | "betterstack_peterheinz";

export interface PracticalExample {
  use_case: string;
  why_it_fits: string;
  gotcha: string;
}

export interface GeneratedCardPayload {
  id?: string;
  front: string;
  back: string;
  topic?: string | null;
  subtopic?: string | null;
  next_due_at?: string | null;
  examples?: PracticalExample[];
}

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
  examples?: PracticalExample[];
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
    usage?: UsageTotals;
  }[];
  usage?: UsageTotals;
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
  covered_points?: string[];
  missed_points: string[];
  ideal_short_answer: string;
  examples?: PracticalExample[];
  cards: GeneratedCardPayload[];
  breakdown: {
    must_have_coverage: number;
    answer_clarity: number;
    tradeoff_coverage: number;
    speed_score: number;
    red_flag_penalty: number;
  };
}

export interface GradingEvaluation {
  id: string;
  user_id: string;
  session_id: string;
  attempt_id: string;
  drill_id: string;
  provider: "openrouter";
  model: string;
  score: number | null;
  verdict: "pass" | "borderline" | "fail" | null;
  covered_points: string[] | null;
  missed_points: string[] | null;
  ideal_answer: string | null;
  raw_json: Record<string, unknown> | null;
  latency_ms: number | null;
  error: string | null;
  estimated_cost_usd: number | null;
  prompt_hash: string;
  created_at: string;
  cached?: boolean;
}

export interface RealtimeToken {
  client_secret: string;
  expires_at: number;
  model: string;
  session_id: string | null;
  voice: string;
}

export interface ElevenLabsConversationToken {
  token: string;
  agent_id: string;
  expires_at: number | null;
}

export type VoiceProvider = "openai" | "elevenlabs";

export type VadMode = "server_vad" | "semantic_vad";
export type SemanticVadEagerness = "low" | "medium" | "high" | "auto";

export interface RealtimeSettings {
  voice_speed: number;
  vad: {
    mode: VadMode;
    threshold: number;
    prefix_padding_ms: number;
    silence_duration_ms: number;
    eagerness: SemanticVadEagerness;
    interrupt_response: boolean;
  };
}

export interface UsageTotals {
  events: number;
  model?: string | null;
  response_id?: string | null;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  input_text_tokens: number;
  input_audio_tokens: number;
  cached_tokens: number;
  output_text_tokens: number;
  output_audio_tokens: number;
  estimated_cost_usd: number | null;
}

export interface UsageSummary {
  total: UsageTotals;
  session: UsageTotals | null;
  by_source: (UsageTotals & { source: string })[];
  by_attempt: (UsageTotals & {
    attempt_id: string;
    drill_id: string | null;
  })[];
}

export interface RealtimeUsageEvent {
  source: "realtime_response" | "realtime_transcription";
  model?: string | null;
  response_id?: string | null;
  usage: UsageTotals & { raw_usage?: Record<string, unknown> };
}

export type ApiErrorPayload = {
  error?: string;
  message?: string;
  request_id?: string;
  openai_request_id?: string | null;
  openai_status?: number;
  elevenlabs_request_id?: string | null;
  elevenlabs_status?: number;
  retryable?: boolean;
  retry_after?: string | null;
};

export class ApiError extends Error {
  status: number;
  statusText: string;
  path: string;
  payload: ApiErrorPayload | null;
  requestId: string | null;
  openaiRequestId: string | null;
  openaiStatus: number | null;
  retryable: boolean;

  constructor(opts: {
    message: string;
    status: number;
    statusText: string;
    path: string;
    payload: ApiErrorPayload | null;
    requestId: string | null;
  }) {
    super(opts.message);
    this.name = "ApiError";
    this.status = opts.status;
    this.statusText = opts.statusText;
    this.path = opts.path;
    this.payload = opts.payload;
    this.requestId = opts.requestId ?? opts.payload?.request_id ?? null;
    this.openaiRequestId = opts.payload?.openai_request_id ?? null;
    this.openaiStatus = opts.payload?.openai_status ?? null;
    this.retryable = opts.payload?.retryable ?? false;
  }
}

export function isApiError(err: unknown): err is ApiError {
  return err instanceof ApiError;
}

async function jsonFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  if (!res.ok) {
    const payload = parseErrorPayload(text);
    const message = payload?.message ?? payload?.error ?? (text || path);
    throw new ApiError({
      message: `${res.status} ${res.statusText}: ${message}`,
      status: res.status,
      statusText: res.statusText,
      path,
      payload,
      requestId: res.headers.get("x-request-id"),
    });
  }
  return (text ? JSON.parse(text) : {}) as T;
}

function parseErrorPayload(text: string): ApiErrorPayload | null {
  if (!text.trim()) return null;
  try {
    return JSON.parse(text) as ApiErrorPayload;
  } catch {
    return { error: text };
  }
}

export const api = {
  health: () =>
    jsonFetch<{
      ok: boolean;
      drills: number;
      openai_configured: boolean;
      openrouter_configured?: boolean;
      elevenlabs_configured?: boolean;
      elevenlabs_api_key_present?: boolean;
      voice_provider?: VoiceProvider;
    }>("/api/health"),

  elevenLabsConversationToken: () =>
    jsonFetch<ElevenLabsConversationToken>(
      "/api/elevenlabs/conversation-token",
      { method: "POST", body: "{}" },
    ),

  startSession: (mode: Mode) =>
    jsonFetch<{ session: SessionPayload }>("/api/drill-sessions", {
      method: "POST",
      body: JSON.stringify({ mode }),
    }).then((r) => r.session),

  retryDrill: (sessionId: string, drillId: string) =>
    jsonFetch<{ drill: DrillPayload }>(
      `/api/drill-sessions/${sessionId}/retry`,
      {
        method: "POST",
        body: JSON.stringify({ drill_id: drillId }),
      },
    ).then((r) => r.drill),

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

  realtimeToken: (settings?: RealtimeSettings) =>
    jsonFetch<RealtimeToken>("/api/realtime/token", {
      method: "POST",
      body: JSON.stringify(settings ?? {}),
    }),

  recordRealtimeUsage: (body: {
    session_id: string;
    attempt_id?: string;
    drill_id?: string;
    source: RealtimeUsageEvent["source"];
    model?: string | null;
    response_id?: string | null;
    usage: RealtimeUsageEvent["usage"];
  }) =>
    jsonFetch<{ ok: boolean; session: UsageTotals }>("/api/realtime/usage", {
      method: "POST",
      body: JSON.stringify(body),
    }),

  usageSummary: (sessionId?: string) =>
    jsonFetch<UsageSummary>(
      `/api/usage/summary${sessionId ? `?session_id=${encodeURIComponent(sessionId)}` : ""}`,
    ),

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
      cards: (GeneratedCardPayload & { id: string })[];
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

  sessionEvents: (sessionId: string) =>
    jsonFetch<{
      events: {
        id: number;
        session_id: string;
        event_type:
          | "session_created"
          | "session_resumed"
          | "drill_picked"
          | "transcript_submitted"
          | "grade_completed"
          | "draft_activated"
          | "draft_deactivated"
          | "draft_discarded"
          | "drill_imported"
          | "session_ended";
        payload: Record<string, unknown> | null;
        created_at: string;
      }[];
    }>(`/api/drill-sessions/${sessionId}/events`),

  endSession: (sessionId: string) =>
    jsonFetch<SessionSummary>(`/api/drill-sessions/${sessionId}/end`, {
      method: "POST",
    }),

  importDrills: (yamlText: string) =>
    fetch("/api/drills/import", {
      method: "POST",
      headers: { "content-type": "application/x-yaml" },
      body: yamlText,
    }).then(async (res) => {
      const json = (await res.json()) as {
        ok: boolean;
        imported: number;
        skipped: { id?: string; error: string }[];
      };
      return { status: res.status, ...json };
    }),

  attemptDetail: (attemptId: string) =>
    jsonFetch<{
      attempt: {
        id: string;
        user_id: string;
        session_id: string;
        drill_id: string;
        transcript: string | null;
        duration_seconds: number | null;
        score: number | null;
        verdict: "pass" | "borderline" | "fail" | null;
        missed_points: string[] | null;
        ideal_answer: string | null;
        created_cards: GeneratedCardPayload[] | null;
        created_at: string;
      };
      evaluations: GradingEvaluation[];
      drill: {
        id: string;
        topic: string;
        subtopic: string;
        difficulty: number;
        question_text: string;
        canonical_short_answer: string;
        rubric: { must_have: string[]; nice_to_have: string[]; red_flags: string[] };
      } | null;
    }>(`/api/drill-attempts/${attemptId}`),

  attemptEvaluations: (attemptId: string) =>
    jsonFetch<{ evaluations: GradingEvaluation[] }>(
      `/api/drill-attempts/${attemptId}/evaluations`,
    ),

  evaluateAttempt: (
    attemptId: string,
    modelsPolicy: "free-pinned" | "free-router" = "free-pinned",
  ) =>
    jsonFetch<{
      evaluations: GradingEvaluation[];
      prompt_hash: string;
      models: string[];
    }>(`/api/drill-attempts/${attemptId}/evaluate`, {
      method: "POST",
      body: JSON.stringify({ models_policy: modelsPolicy }),
    }),

  progressDrills: (limit = 10) =>
    jsonFetch<{
      drills: {
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
      }[];
    }>(`/api/progress/drills?limit=${limit}`),

  recentSessions: (limit = 25) =>
    jsonFetch<{
      sessions: {
        id: string;
        mode: Mode;
        started_at: string;
        ended_at: string | null;
        drills_attempted: number;
        drills_graded: number;
        average_score: number;
      }[];
    }>(`/api/sessions?limit=${limit}`),

  stats: () =>
    jsonFetch<{
      total: number;
      active: number;
      drafts: number;
      by_topic: { topic: string; active: number; drafts: number }[];
      by_difficulty: { difficulty: number; active: number; drafts: number }[];
      by_trap_type: { trap_type: string; count: number }[];
    }>("/api/stats"),

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
        examples: PracticalExample[];
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

  deactivateDrill: (id: string) =>
    jsonFetch<{ ok: boolean }>(`/api/drills/${id}/deactivate`, {
      method: "POST",
      body: "{}",
    }),

  deleteDrill: (id: string) =>
    jsonFetch<{ ok: boolean }>(`/api/drills/${id}`, {
      method: "DELETE",
    }),

  patchDrill: (
    id: string,
    fields: {
      question_text?: string;
      canonical_short_answer?: string;
      difficulty?: number;
      trap_type?: string | null;
      examples?: PracticalExample[];
      rubric?: {
        must_have: string[];
        nice_to_have: string[];
        red_flags: string[];
      };
    },
  ) =>
    jsonFetch<{
      ok: boolean;
      drill: {
        id: string;
        rubric: { must_have: string[]; nice_to_have: string[]; red_flags: string[] };
        canonical_short_answer: string;
        examples: PracticalExample[];
      };
    }>(`/api/drills/${id}`, {
      method: "PATCH",
      body: JSON.stringify(fields),
    }),

  testGrade: (id: string, transcript: string, durationSeconds = 45) =>
    jsonFetch<{
      drill_id: string;
      score: number;
      verdict: "pass" | "borderline" | "fail";
      missed_points: string[];
      ideal_short_answer: string;
      examples?: PracticalExample[];
      breakdown: {
        must_have_coverage: number;
        answer_clarity: number;
        tradeoff_coverage: number;
        speed_score: number;
        red_flag_penalty: number;
      };
      cards: GeneratedCardPayload[];
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
        examples: PracticalExample[];
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

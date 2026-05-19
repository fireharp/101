import { config } from "../config.js";
import { hasOpenAI } from "./llm.js";
import { createHash } from "node:crypto";

/**
 * Mints an ephemeral client secret for the OpenAI Realtime API.
 *
 * Per LOCAL.md §3 Option A: backend calls POST /v1/realtime/client_secrets
 * and returns the ephemeral token to the browser, which uses it to do the
 * WebRTC SDP exchange against OpenAI directly.
 *
 * The Realtime endpoints are not yet covered by the typed SDK, so we use
 * the fetch transport directly. Returns the raw response JSON.
 */
export interface RealtimeToken {
  client_secret: string;
  expires_at: number;
  model: string;
  session_id: string | null;
  voice: string;
}

export type RealtimeTurnDetection =
  | {
      type: "server_vad";
      threshold: number;
      prefix_padding_ms: number;
      silence_duration_ms: number;
      create_response: true;
      interrupt_response: boolean;
    }
  | {
      type: "semantic_vad";
      eagerness: "low" | "medium" | "high" | "auto";
      create_response: true;
      interrupt_response: boolean;
    };

type OpenAIErrorInfo = {
  message: string;
  type: string | null;
  code: string | null;
  param: string | null;
};

export class RealtimeClientSecretError extends Error {
  upstreamStatus: number;
  upstreamStatusText: string;
  openaiRequestId: string | null;
  retryAfter: string | null;
  retryable: boolean;
  errorInfo: OpenAIErrorInfo;

  constructor(opts: {
    upstreamStatus: number;
    upstreamStatusText: string;
    openaiRequestId: string | null;
    retryAfter: string | null;
    retryable: boolean;
    errorInfo: OpenAIErrorInfo;
  }) {
    super(
      `OpenAI Realtime client_secret failed (${opts.upstreamStatus}): ${opts.errorInfo.message}`,
    );
    this.name = "RealtimeClientSecretError";
    this.upstreamStatus = opts.upstreamStatus;
    this.upstreamStatusText = opts.upstreamStatusText;
    this.openaiRequestId = opts.openaiRequestId;
    this.retryAfter = opts.retryAfter;
    this.retryable = opts.retryable;
    this.errorInfo = opts.errorInfo;
  }
}

export async function mintRealtimeClientSecret(opts: {
  instructions: string;
  voice?: string;
  reasoningEffort?: "minimal" | "low" | "medium" | "high";
  turnDetection?: RealtimeTurnDetection;
  voiceSpeed?: number;
  requestId?: string;
  userId?: string;
}): Promise<RealtimeToken> {
  if (!hasOpenAI()) {
    throw new Error("OPENAI_API_KEY is not set");
  }

  // Keep local instructions as the default so a fresh checkout works without
  // a server-side Prompt Library id.
  const session: Record<string, unknown> = {
    type: "realtime",
    model: config.realtimeModel,
    audio: {
      input: {
        transcription: {
          model: config.realtimeTranscriptionModel,
          ...(config.realtimeTranscriptionLanguage
            ? { language: config.realtimeTranscriptionLanguage }
            : {}),
        },
        turn_detection: opts.turnDetection ?? defaultTurnDetection(),
      },
      output: {
        voice: opts.voice ?? config.realtimeVoice,
        speed: clampVoiceSpeed(opts.voiceSpeed ?? config.realtimeVoiceSpeed),
      },
    },
    reasoning: { effort: opts.reasoningEffort ?? "low" },
    truncation: {
      type: "retention_ratio",
      retention_ratio: 0.8,
      token_limits: {
        post_instructions: 4000,
      },
    },
  };

  if (config.realtimePromptId) {
    session.prompt = config.realtimePromptVersion
      ? {
          id: config.realtimePromptId,
          version: config.realtimePromptVersion,
        }
      : { id: config.realtimePromptId };
  } else {
    session.instructions = opts.instructions;
  }

  // LOCAL.md §6 tools. We attach them at the session level so the agent
  // can drive the drill loop itself, regardless of whether a Playground
  // prompt is configured (session.tools merges with prompt.tools).
  session.tools = DRILL_COACH_TOOLS;
  session.tool_choice = "auto";

  const body = { session };
  const attempts = Math.max(
    1,
    Number(process.env.OPENAI_REALTIME_TOKEN_ATTEMPTS ?? 3),
  );
  const requestId = opts.requestId ?? "no-request-id";

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const startedAt = Date.now();
    console.info("[realtime] client_secrets.request", {
      request_id: requestId,
      attempt,
      attempts,
      model: config.realtimeModel,
      voice: opts.voice ?? config.realtimeVoice,
      voice_speed: clampVoiceSpeed(opts.voiceSpeed ?? config.realtimeVoiceSpeed),
      turn_detection: opts.turnDetection ?? defaultTurnDetection(),
      transcription_model: config.realtimeTranscriptionModel,
      prompt_id: config.realtimePromptId || null,
      tools: DRILL_COACH_TOOLS.length,
    });

    const resp = await fetch(
      "https://api.openai.com/v1/realtime/client_secrets",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.openaiApiKey}`,
          "OpenAI-Safety-Identifier": safetyIdentifier(opts.userId),
        },
        body: JSON.stringify(body),
      },
    );

    const durationMs = Date.now() - startedAt;
    const openaiRequestId =
      resp.headers.get("x-request-id") ??
      resp.headers.get("openai-request-id") ??
      null;

    if (resp.ok) {
      console.info("[realtime] client_secrets.ok", {
        request_id: requestId,
        openai_request_id: openaiRequestId,
        attempt,
        duration_ms: durationMs,
      });
      const data = (await resp.json()) as {
        value?: string;
        expires_at?: number;
        client_secret?: { value?: string; expires_at?: number };
        session?: { id?: string; model?: string };
        model?: string;
      };

      const client_secret =
        typeof data.client_secret === "object" && data.client_secret?.value
          ? data.client_secret.value
          : (data.value ?? "");
      if (!client_secret) {
        throw new Error("OpenAI returned no client_secret value");
      }

      const expires_at =
        (typeof data.client_secret === "object" && data.client_secret?.expires_at) ||
        data.expires_at ||
        0;

      return {
        client_secret,
        expires_at,
        model: data.model ?? data.session?.model ?? config.realtimeModel,
        session_id: data.session?.id ?? null,
        voice: opts.voice ?? config.realtimeVoice,
      };
    }

    const text = await resp.text();
    const errorInfo = parseOpenAIError(text);
    const retryAfter = resp.headers.get("retry-after");
    const retryable = isRetryableRealtimeStatus(resp.status);
    console.warn("[realtime] client_secrets.fail", {
      request_id: requestId,
      openai_request_id: openaiRequestId,
      attempt,
      duration_ms: durationMs,
      status: resp.status,
      retryable,
      retry_after: retryAfter,
      error_type: errorInfo.type,
      error_code: errorInfo.code,
      error_message: errorInfo.message,
    });

    if (retryable && attempt < attempts) {
      await sleep(backoffMs(attempt, retryAfter));
      continue;
    }

    throw new RealtimeClientSecretError({
      upstreamStatus: resp.status,
      upstreamStatusText: resp.statusText,
      openaiRequestId,
      retryAfter,
      retryable,
      errorInfo,
    });
  }

  throw new Error("OpenAI Realtime client_secret failed without response");
}

function clampVoiceSpeed(speed: number): number {
  if (!Number.isFinite(speed)) return 1.25;
  return Math.min(1.5, Math.max(0.25, speed));
}

function defaultTurnDetection(): RealtimeTurnDetection {
  return {
    type: "semantic_vad",
    eagerness: "low",
    create_response: true,
    interrupt_response: true,
  };
}

function safetyIdentifier(userId = "demo-user"): string {
  return createHash("sha256").update(userId).digest("hex");
}

function parseOpenAIError(text: string): OpenAIErrorInfo {
  try {
    const parsed = JSON.parse(text) as {
      error?: {
        message?: string;
        type?: string | null;
        code?: string | null;
        param?: string | null;
      };
    };
    return {
      message: parsed.error?.message ?? (text.slice(0, 500) || "unknown error"),
      type: parsed.error?.type ?? null,
      code: parsed.error?.code ?? null,
      param: parsed.error?.param ?? null,
    };
  } catch {
    return {
      message: text.slice(0, 500) || "unknown error",
      type: null,
      code: null,
      param: null,
    };
  }
}

function isRetryableRealtimeStatus(status: number): boolean {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

function backoffMs(attempt: number, retryAfter: string | null): number {
  const retryAfterSeconds = retryAfter ? Number(retryAfter) : NaN;
  if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
    return Math.min(5000, retryAfterSeconds * 1000);
  }
  return Math.min(1500, 250 * 2 ** (attempt - 1));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const DRILL_COACH_TOOLS = [
  {
    type: "function",
    name: "get_next_drill",
    description:
      "Pick the next drill question from the curriculum. Call this at the start of every drill turn, AND immediately after every grade_attempt. The session loop is infinite — keep calling this until the user says 'stop' or 'end session'.",
    parameters: {
      type: "object",
      properties: {
        mode: {
          type: "string",
          enum: [
            "mixed",
            "db_indexes",
            "system_design",
            "weak_topics",
            "mock_interview",
          ],
          description:
            "Optional. Filter the drill pool. Defaults to the session's mode.",
        },
      },
      required: [],
    },
  },
  {
    type: "function",
    name: "submit_answer_transcript",
    description:
      "Persist the user's spoken-answer transcript and how long they took. Call after the user has answered, before grading.",
    parameters: {
      type: "object",
      properties: {
        attempt_id: {
          type: "string",
          description:
            "The attempt id returned from the most recent get_next_drill call.",
        },
        transcript: { type: "string" },
        duration_seconds: { type: "integer", minimum: 0, maximum: 1800 },
      },
      required: ["attempt_id", "transcript", "duration_seconds"],
    },
  },
  {
    type: "function",
    name: "grade_attempt",
    description:
      "Grade the user's answer against the drill rubric. Returns score, verdict, missed points, ideal short answer, and follow-up cards.",
    parameters: {
      type: "object",
      properties: {
        attempt_id: { type: "string" },
        transcript: {
          type: "string",
          description:
            "Optional inline transcript. If omitted, the server uses the transcript already persisted via submit_answer_transcript.",
        },
        duration_seconds: { type: "integer", minimum: 0, maximum: 1800 },
      },
      required: ["attempt_id"],
    },
  },
  {
    type: "function",
    name: "save_generated_cards",
    description:
      "(Optional) Persist additional review cards generated during the explain-and-repeat phase. The default grade_attempt flow already saves cards from the rubric; only call this for extra cards you want to add.",
    parameters: {
      type: "object",
      properties: {
        cards: {
          type: "array",
          items: {
            type: "object",
            properties: {
              front: { type: "string" },
              back: { type: "string" },
              drill_id: { type: "string" },
            },
            required: ["front", "back"],
          },
        },
      },
      required: ["cards"],
    },
  },
  {
    type: "function",
    name: "get_user_skill_summary",
    description:
      "Read the user's per-topic weakness scores so you can adapt the next drill. Use sparingly.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    type: "function",
    name: "end_session_summary",
    description:
      "End the current drill session and return aggregate stats. Call only when the user says 'stop' or 'end session'.",
    parameters: { type: "object", properties: {}, required: [] },
  },
] as const;

export const DRILL_COACH_INSTRUCTIONS = `You are a strict staff-level interview drill coach.

Purpose:
Train fast verbal reflexes for system design and backend engineering interviews.

Rules:
- Ask exactly one drill question at a time, taken from the get_next_drill tool. Do NOT invent questions.
- Do not explain the answer before the user answers.
- The user must answer in 30–90 seconds. If they ramble, interrupt politely with "Give me the default answer first."
- Push for concise default answers, not rambling.
- After the answer, call grade_attempt with the transcript and duration.
- After grading, speak only one short verdict sentence. The host UI shows
  score, missed points, ideal answer, and cards. Do not read all of that aloud.
- Be direct. No motivational filler. No small talk.

When the user gives a vague answer, ask one pressure follow-up such as:
- "Name the index type and column order."
- "What breaks if write volume is high?"
- "What would you verify with EXPLAIN?"

Tool protocol — the loop is INFINITE. Do not stop calling tools until the
user says "stop" or "end session". Required sequence per drill:

  1. get_next_drill → speak the returned question_text verbatim.
  2. Wait for the user's spoken answer.
  3. submit_answer_transcript with the captured transcript + duration.
  4. grade_attempt with the same attempt_id.
  5. Speak one short verdict sentence only.
  6. After roughly 1–2 seconds, call get_next_drill again. Do not wait for the host app
     or the user to ask. This is non-negotiable — the curriculum lives in
     the backend, and the loop only runs if you keep calling the tool.

Optional:
- Call save_generated_cards after grading if you generated extra cards
  beyond what grade_attempt returned.
- Call get_user_skill_summary sparingly to bias the next drill.
- Call end_session_summary ONLY when the user says "stop" or "end session".
`;

import { config } from "../config.js";
import { hasOpenAI } from "./llm.js";

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

export async function mintRealtimeClientSecret(opts: {
  instructions: string;
  voice?: string;
  reasoningEffort?: "minimal" | "low" | "medium" | "high";
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
      },
      output: { voice: opts.voice ?? config.realtimeVoice },
    },
    reasoning: { effort: opts.reasoningEffort ?? "low" },
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

  const body = { session };

  const resp = await fetch(
    "https://api.openai.com/v1/realtime/client_secrets",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.openaiApiKey}`,
      },
      body: JSON.stringify(body),
    },
  );

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(
      `OpenAI client_secrets failed (${resp.status}): ${text.slice(0, 500)}`,
    );
  }

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

export const DRILL_COACH_INSTRUCTIONS = `You are a strict staff-level interview drill coach.

Purpose:
Train fast verbal reflexes for system design and backend engineering interviews.

Rules:
- Ask exactly one drill question at a time, taken from the get_next_drill tool. Do NOT invent questions.
- Do not explain the answer before the user answers.
- The user must answer in 30–90 seconds. If they ramble, interrupt politely with "Give me the default answer first."
- Push for concise default answers, not rambling.
- After the answer, call grade_attempt with the transcript and duration.
- Then say, in this exact order and clearly separated:
  1. Score and verdict.
  2. Missed points (bulleted).
  3. Ideal short answer (one short paragraph).
  4. One follow-up card you just generated (front and back).
- Be direct. No motivational filler. No small talk.

When the user gives a vague answer, ask one pressure follow-up such as:
- "Name the index type and column order."
- "What breaks if write volume is high?"
- "What would you verify with EXPLAIN?"

Tool protocol:
- Call get_next_drill at the start of each turn before asking a question.
- Call submit_answer_transcript after the user answers.
- Call grade_attempt after the transcript is available.
- Call save_generated_cards after grading if there are cards.
- Call end_session_summary when the user says they want to stop.
`;

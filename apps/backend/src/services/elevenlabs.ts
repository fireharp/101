import { config } from "../config.js";
import { DRILL_COACH_INSTRUCTIONS } from "./realtime.js";

/**
 * Server-side ElevenLabs Agents helpers. Per ELEVENLABS.md §6/§7:
 *
 *   - `ELEVENLABS_API_KEY` lives on the backend only.
 *   - `mintConversationToken` calls `GET /v1/convai/conversation/token`
 *     and hands the browser a short-lived conversation token.
 *   - `createOrUpdateAgent` is the idempotent setup hook used by
 *     `pnpm elevenlabs:setup`. It (re)configures the dev agent with the
 *     drill-coach prompt and the six client-tool stubs that mirror the
 *     existing OpenAI Realtime tool contract.
 *
 * Tool execution is deliberately NOT done here — the browser receives a
 * client-tool call, forwards it to `/api/realtime/tool-call`, and the
 * answer goes back to ElevenLabs. The backend stays the single source of
 * truth for curriculum and grading regardless of provider.
 */

const ELEVENLABS_API_BASE = "https://api.elevenlabs.io";

export class ElevenLabsError extends Error {
  upstreamStatus: number | null;
  upstreamBody: string | null;
  upstreamRequestId: string | null;

  constructor(opts: {
    message: string;
    upstreamStatus?: number | null;
    upstreamBody?: string | null;
    upstreamRequestId?: string | null;
  }) {
    super(opts.message);
    this.name = "ElevenLabsError";
    this.upstreamStatus = opts.upstreamStatus ?? null;
    this.upstreamBody = opts.upstreamBody ?? null;
    this.upstreamRequestId = opts.upstreamRequestId ?? null;
  }
}

export interface ElevenLabsConversationToken {
  token: string;
  agent_id: string;
  expires_at: number | null;
}

export interface ElevenLabsAgentRef {
  agent_id: string;
  name: string;
  voice_id: string | null;
  created: boolean;
}

export function hasElevenLabs(): boolean {
  return Boolean(config.elevenLabsApiKey);
}

export function elevenLabsConfigured(): boolean {
  return Boolean(config.elevenLabsApiKey) && Boolean(config.elevenLabsAgentId);
}

/**
 * Per ELEVENLABS.md §6: ask ElevenLabs for a short-lived conversation
 * token tied to our dev agent id. The browser then opens a WebRTC
 * conversation against ElevenLabs using only this token.
 */
export async function mintConversationToken(
  agentId: string,
): Promise<ElevenLabsConversationToken> {
  if (!config.elevenLabsApiKey) {
    throw new ElevenLabsError({ message: "ELEVENLABS_API_KEY is not set" });
  }
  if (!agentId) {
    throw new ElevenLabsError({ message: "ELEVENLABS_AGENT_ID is not set" });
  }

  const url = new URL(`${ELEVENLABS_API_BASE}/v1/convai/conversation/token`);
  url.searchParams.set("agent_id", agentId);

  const resp = await fetch(url, {
    method: "GET",
    headers: { "xi-api-key": config.elevenLabsApiKey },
  });

  const requestId =
    resp.headers.get("x-request-id") ??
    resp.headers.get("request-id") ??
    null;

  if (!resp.ok) {
    const body = await resp.text();
    throw new ElevenLabsError({
      message: `ElevenLabs conversation-token failed (${resp.status})`,
      upstreamStatus: resp.status,
      upstreamBody: body.slice(0, 1000),
      upstreamRequestId: requestId,
    });
  }

  const data = (await resp.json()) as {
    token?: string;
    conversation_token?: string;
    expires_at?: number;
  };
  const token = data.token ?? data.conversation_token ?? "";
  if (!token) {
    throw new ElevenLabsError({
      message: "ElevenLabs returned no token field",
      upstreamStatus: resp.status,
      upstreamRequestId: requestId,
    });
  }
  return {
    token,
    agent_id: agentId,
    expires_at: data.expires_at ?? null,
  };
}

/**
 * Mirror of the OpenAI Realtime `DRILL_COACH_TOOLS` adapted for the
 * ElevenLabs client-tool shape. ElevenLabs expects a `client_tools` array
 * inside the prompt configuration; tool execution happens in the browser
 * (which proxies to `/api/realtime/tool-call`).
 *
 * Schemas mirror the existing tool contract so backend dispatch logic
 * works without provider-aware branches.
 */
export const ELEVENLABS_CLIENT_TOOLS = [
  {
    name: "get_next_drill",
    description:
      "Pick the next drill question from the backend curriculum. Call at the start of every drill turn, AND immediately after every grade_attempt. The session loop is infinite — keep calling until the user says 'stop' or 'end session'.",
    parameters: {
      type: "object",
      properties: {
        mode: {
          type: "string",
          enum: [
            "mixed",
            "db_indexes",
            "system_design",
            "dwelly_system_design",
            "weak_topics",
            "mock_interview",
          ],
          description:
            "Optional. Filter the drill pool. Defaults to the session's mode.",
        },
      },
      required: [],
      description: "Optional drill selection controls.",
    },
    expects_response: true,
    response_timeout_secs: 15,
  },
  {
    name: "submit_answer_transcript",
    description:
      "Persist the user's spoken-answer transcript and how long they took. Call after the user answers, before grading.",
    parameters: {
      type: "object",
      properties: {
        attempt_id: {
          type: "string",
          description:
            "Attempt id returned by the current get_next_drill call.",
        },
        transcript: {
          type: "string",
          description: "User spoken answer transcript.",
        },
        duration_seconds: {
          type: "integer",
          minimum: 0,
          maximum: 1800,
          description: "Answer duration in seconds.",
        },
      },
      required: ["attempt_id", "transcript", "duration_seconds"],
      description: "Transcript payload to persist before grading.",
    },
    expects_response: true,
    response_timeout_secs: 15,
  },
  {
    name: "grade_attempt",
    description:
      "Grade the user's answer against the drill rubric. Returns score, verdict, missed points, ideal short answer, practical examples, and follow-up cards.",
    parameters: {
      type: "object",
      properties: {
        attempt_id: {
          type: "string",
          description:
            "Attempt id returned by the current get_next_drill call.",
        },
        transcript: {
          type: "string",
          description:
            "Optional user transcript. If omitted, the backend uses the persisted transcript.",
        },
        duration_seconds: {
          type: "integer",
          minimum: 0,
          maximum: 1800,
          description:
            "Optional answer duration in seconds. Used when transcript is supplied inline.",
        },
      },
      required: ["attempt_id"],
      description: "Grading request for a completed attempt.",
    },
    expects_response: true,
    response_timeout_secs: 30,
  },
  {
    name: "save_generated_cards",
    description:
      "(Optional) Persist additional review cards generated during explain-and-repeat. The default grade_attempt flow already saves cards from the rubric.",
    parameters: {
      type: "object",
      properties: {
        cards: {
          type: "array",
          items: {
            type: "object",
            properties: {
              front: {
                type: "string",
                description: "Front side of the review card.",
              },
              back: {
                type: "string",
                description: "Back side of the review card.",
              },
              drill_id: {
                type: "string",
                description: "Optional related drill id.",
              },
              topic: {
                type: "string",
                description: "Optional topic tag.",
              },
              subtopic: {
                type: "string",
                description: "Optional subtopic tag.",
              },
              examples: {
                type: "array",
                description: "Optional practical examples to keep on the card.",
                items: {
                  type: "object",
                  properties: {
                    use_case: { type: "string" },
                    why_it_fits: { type: "string" },
                    gotcha: { type: "string" },
                  },
                  required: ["use_case", "why_it_fits", "gotcha"],
                  description: "Concrete review context for the card.",
                },
              },
            },
            required: ["front", "back"],
            description: "Review card to persist.",
          },
        },
      },
      required: ["cards"],
      description: "Additional generated review cards.",
    },
    expects_response: true,
    response_timeout_secs: 15,
  },
  {
    name: "get_user_skill_summary",
    description:
      "Read the user's per-topic weakness scores so you can adapt the next drill. Use sparingly.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
      description: "No arguments.",
    },
    expects_response: true,
    response_timeout_secs: 15,
  },
  {
    name: "end_session_summary",
    description:
      "End the current drill session and return aggregate stats. Call only when the user says 'stop' or 'end session'.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
      description: "No arguments.",
    },
    expects_response: true,
    response_timeout_secs: 15,
  },
] as const;

interface AgentSummary {
  agent_id: string;
  name: string;
  voice_id?: string | null;
}

interface ListAgentsResponse {
  agents?: AgentSummary[];
}

async function listAgents(opts?: { search?: string }): Promise<AgentSummary[]> {
  // The GET /v1/convai/agents endpoint defaults to page_size=30 and
  // supports a `search` query param ("Search by agents name"). Using it
  // when we know the name avoids paginating through unrelated agents and
  // keeps the lookup O(1) for an idempotent setup.
  const url = new URL(`${ELEVENLABS_API_BASE}/v1/convai/agents`);
  if (opts?.search) url.searchParams.set("search", opts.search);
  url.searchParams.set("page_size", "100");
  const resp = await fetch(url, {
    method: "GET",
    headers: { "xi-api-key": config.elevenLabsApiKey },
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new ElevenLabsError({
      message: `ElevenLabs list agents failed (${resp.status})`,
      upstreamStatus: resp.status,
      upstreamBody: body.slice(0, 1000),
    });
  }
  const data = (await resp.json()) as ListAgentsResponse;
  return data.agents ?? [];
}

function buildAgentConfig(opts: { voiceId: string | null }) {
  // ElevenLabs Convai accepts the wrapped `conversation_config.agent.prompt`
  // shape on POST /v1/convai/agents/create and PATCH /v1/convai/agents/{id}.
  // Verified against the live API on 2026-05-20 (closed ELEVENLABS.md §6's
  // open item). If a future API revision rejects this with 422, the
  // upstream body is bubbled up in ElevenLabsError.upstreamBody.
  const conversationConfig: Record<string, unknown> = {
    agent: {
      language: "en",
      first_message:
        "Drill coach ready. I'll pull a question from the bank and ask it; answer in 30 to 90 seconds.",
      prompt: {
        prompt: DRILL_COACH_INSTRUCTIONS,
        llm: config.elevenLabsLlmModel,
        // ElevenLabs accepts `tools` as inline client_tool definitions on
        // the prompt. The SDK also registers per-session client_tools at
        // start time as a backstop, so this primarily documents the
        // agent's contract for dashboard reviewers.
        tools: ELEVENLABS_CLIENT_TOOLS.map((tool) => ({
          type: "client",
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
          expects_response: tool.expects_response,
          response_timeout_secs: tool.response_timeout_secs,
        })),
      },
    },
    tts: opts.voiceId ? { voice_id: opts.voiceId } : undefined,
  };
  if (!conversationConfig.tts) delete conversationConfig.tts;
  return { conversation_config: conversationConfig };
}

async function createAgent(opts: {
  name: string;
  voiceId: string | null;
}): Promise<AgentSummary> {
  const resp = await fetch(`${ELEVENLABS_API_BASE}/v1/convai/agents/create`, {
    method: "POST",
    headers: {
      "xi-api-key": config.elevenLabsApiKey,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      name: opts.name,
      ...buildAgentConfig({ voiceId: opts.voiceId }),
    }),
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new ElevenLabsError({
      message: `ElevenLabs create agent failed (${resp.status})`,
      upstreamStatus: resp.status,
      upstreamBody: body.slice(0, 1500),
    });
  }
  const data = (await resp.json()) as {
    agent_id?: string;
    name?: string;
  };
  if (!data.agent_id) {
    throw new ElevenLabsError({
      message: "ElevenLabs create agent returned no agent_id",
      upstreamStatus: resp.status,
    });
  }
  return {
    agent_id: data.agent_id,
    name: data.name ?? opts.name,
    voice_id: opts.voiceId,
  };
}

async function updateAgent(opts: {
  agentId: string;
  name: string;
  voiceId: string | null;
}): Promise<AgentSummary> {
  const resp = await fetch(
    `${ELEVENLABS_API_BASE}/v1/convai/agents/${encodeURIComponent(opts.agentId)}`,
    {
      method: "PATCH",
      headers: {
        "xi-api-key": config.elevenLabsApiKey,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        name: opts.name,
        ...buildAgentConfig({ voiceId: opts.voiceId }),
      }),
    },
  );
  if (!resp.ok) {
    const body = await resp.text();
    throw new ElevenLabsError({
      message: `ElevenLabs update agent failed (${resp.status})`,
      upstreamStatus: resp.status,
      upstreamBody: body.slice(0, 1500),
    });
  }
  return {
    agent_id: opts.agentId,
    name: opts.name,
    voice_id: opts.voiceId,
  };
}

/**
 * Idempotent setup helper. Resolution order:
 *
 *   1. If `ELEVENLABS_AGENT_ID` is set, PATCH that agent (refreshes the
 *      prompt + tools to whatever the spec currently says).
 *   2. Otherwise list agents, find one matching `name`, and PATCH it.
 *   3. Otherwise create a fresh agent.
 *
 * Returns the resolved agent ref. The script then writes `agent_id` back
 * to `.env`.
 */
export async function createOrUpdateAgent(opts?: {
  name?: string;
  voiceId?: string | null;
  agentId?: string | null;
}): Promise<ElevenLabsAgentRef> {
  if (!config.elevenLabsApiKey) {
    throw new ElevenLabsError({ message: "ELEVENLABS_API_KEY is not set" });
  }

  const name = opts?.name ?? config.elevenLabsAgentName;
  const voiceId = (opts?.voiceId ?? config.elevenLabsVoiceId) || null;
  const existingId = opts?.agentId ?? config.elevenLabsAgentId;

  if (existingId) {
    try {
      const updated = await updateAgent({
        agentId: existingId,
        name,
        voiceId,
      });
      return { ...updated, voice_id: voiceId, created: false };
    } catch (err) {
      // If the stored id is stale (e.g. agent was deleted in dashboard),
      // fall through to lookup-by-name + create.
      if (
        !(err instanceof ElevenLabsError) ||
        (err.upstreamStatus !== 404 && err.upstreamStatus !== 400)
      ) {
        throw err;
      }
    }
  }

  const agents = await listAgents({ search: name });
  const match = agents.find((a) => a.name === name);
  if (match) {
    const updated = await updateAgent({
      agentId: match.agent_id,
      name,
      voiceId,
    });
    return { ...updated, voice_id: voiceId, created: false };
  }

  const created = await createAgent({ name, voiceId });
  return { ...created, voice_id: voiceId, created: true };
}

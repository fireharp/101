import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Load .env from backend, then fall back to repo root so a single shared
// .env at the workspace root works in dev.
dotenv.config({ path: path.join(__dirname, "..", ".env") });
dotenv.config({ path: path.join(__dirname, "..", "..", "..", ".env") });

export const config = {
  port: Number(process.env.PORT ?? 4000),
  dbPath: path.resolve(
    process.env.DATABASE_PATH ?? path.join(__dirname, "..", "data", "drill.db"),
  ),
  seedsDir: path.resolve(path.join(__dirname, "..", "seeds", "drills")),
  openaiApiKey: process.env.OPENAI_API_KEY ?? "",
  realtimeModel: process.env.OPENAI_REALTIME_MODEL ?? "gpt-realtime-2",
  realtimeTranscriptionModel:
    process.env.OPENAI_REALTIME_TRANSCRIPTION_MODEL ??
    "gpt-4o-mini-transcribe",
  realtimeTranscriptionLanguage:
    process.env.OPENAI_REALTIME_TRANSCRIPTION_LANGUAGE ?? "",
  gradingModel: process.env.OPENAI_GRADING_MODEL ?? "gpt-4.1-mini",
  get openRouterApiKey(): string {
    return process.env.OPENROUTER_API_KEY ?? "";
  },
  get openRouterBaseUrl(): string {
    return process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1";
  },
  get openRouterModelTtlMs(): number {
    return Number(process.env.OPENROUTER_MODEL_TTL_MS ?? 10 * 60 * 1000);
  },
  get openRouterCooldownMs(): number {
    return Number(process.env.OPENROUTER_COOLDOWN_MS ?? 10 * 60 * 1000);
  },
  get openRouterTimeoutMs(): number {
    return Number(process.env.OPENROUTER_TIMEOUT_MS ?? 20_000);
  },
  realtimeVoice: process.env.REALTIME_VOICE ?? "marin",
  realtimeVoiceSpeed: Number(process.env.OPENAI_REALTIME_VOICE_SPEED ?? 1.25),
  // Optional: reference an OpenAI server-side prompt (Prompt Library) instead
  // of inlining local Realtime instructions.
  realtimePromptId: process.env.OPENAI_REALTIME_PROMPT_ID ?? "",
  realtimePromptVersion: process.env.OPENAI_REALTIME_PROMPT_VERSION ?? "",
  frontendOrigin: process.env.FRONTEND_ORIGIN ?? "http://localhost:5173",
  useOfflineGrader:
    process.env.USE_OFFLINE_GRADER === "1" || !process.env.OPENAI_API_KEY,

  // ElevenLabs Agents — side-by-side voice provider (ELEVENLABS.md).
  // Reads happen at request time via these getters, so an .env mutated by
  // pnpm elevenlabs:setup picks up without a process restart.
  get elevenLabsApiKey(): string {
    return process.env.ELEVENLABS_API_KEY ?? "";
  },
  get elevenLabsAgentId(): string {
    return process.env.ELEVENLABS_AGENT_ID ?? "";
  },
  get elevenLabsAgentName(): string {
    return process.env.ELEVENLABS_AGENT_NAME ?? "Drill Coach (dev)";
  },
  get elevenLabsVoiceId(): string {
    return process.env.ELEVENLABS_VOICE_ID ?? "";
  },
  get elevenLabsLlmModel(): string {
    return process.env.ELEVENLABS_LLM_MODEL ?? "gpt-5.2";
  },
  get voiceProvider(): "openai" | "elevenlabs" {
    return process.env.VOICE_PROVIDER === "elevenlabs"
      ? "elevenlabs"
      : "openai";
  },
};

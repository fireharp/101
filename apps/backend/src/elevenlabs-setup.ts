import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ElevenLabsError,
  createOrUpdateAgent,
  hasElevenLabs,
} from "./services/elevenlabs.js";
import { config } from "./config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..", "..");
const dotenvPath = path.join(repoRoot, ".env");

async function readEnvFile(): Promise<string> {
  try {
    return await fs.readFile(dotenvPath, "utf8");
  } catch {
    return "";
  }
}

async function writeAgentIdToEnv(agentId: string): Promise<void> {
  const current = await readEnvFile();
  const lines = current ? current.split(/\r?\n/) : [];
  let replaced = false;
  const next = lines.map((line) => {
    if (/^\s*ELEVENLABS_AGENT_ID\s*=/.test(line)) {
      replaced = true;
      return `ELEVENLABS_AGENT_ID=${agentId}`;
    }
    return line;
  });
  if (!replaced) {
    if (next.length > 0 && next[next.length - 1] !== "") next.push("");
    next.push(`ELEVENLABS_AGENT_ID=${agentId}`);
  }
  const body = next.join("\n").replace(/\n+$/g, "\n");
  await fs.writeFile(dotenvPath, body.endsWith("\n") ? body : body + "\n");
}

async function main() {
  if (!hasElevenLabs()) {
    console.error(
      "[elevenlabs:setup] ELEVENLABS_API_KEY is not set. Add it to .env first.",
    );
    process.exit(1);
  }

  const name = config.elevenLabsAgentName;
  const voiceId = config.elevenLabsVoiceId || null;
  const existing = config.elevenLabsAgentId || null;

  console.info("[elevenlabs:setup] resolving agent", {
    name,
    voiceId,
    existingAgentId: existing,
  });

  try {
    const ref = await createOrUpdateAgent({
      name,
      voiceId,
      agentId: existing,
    });
    if (ref.agent_id !== existing) {
      await writeAgentIdToEnv(ref.agent_id);
      console.info(
        `[elevenlabs:setup] wrote ELEVENLABS_AGENT_ID=${ref.agent_id} to ${dotenvPath}`,
      );
    } else {
      console.info("[elevenlabs:setup] agent id unchanged");
    }
    console.info(
      `[elevenlabs:setup] ${ref.created ? "created" : "updated"} agent`,
      {
        agent_id: ref.agent_id,
        name: ref.name,
        voice_id: ref.voice_id,
      },
    );
  } catch (err) {
    if (err instanceof ElevenLabsError) {
      console.error("[elevenlabs:setup] ElevenLabs error", {
        message: err.message,
        status: err.upstreamStatus,
        request_id: err.upstreamRequestId,
        body: err.upstreamBody,
      });
    } else {
      console.error("[elevenlabs:setup] unhandled error", err);
    }
    process.exit(1);
  }
}

void main();

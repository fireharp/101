#!/usr/bin/env node
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const reportDir = path.join(repoRoot, "tmp", "voice-benchmarks");

async function main() {
  const reports = await latestReports();
  const comparison = {
    provider: "comparison",
    timestamp: new Date().toISOString(),
    success_metric: "cost_per_successful_drill_loop",
    openai: reports.openai,
    elevenlabs: reports.elevenlabs,
    debug_errors: [],
  };

  if (!comparison.openai) {
    comparison.debug_errors.push(
      "No OpenAI voice benchmark JSON found. Run pnpm smoke:realtime first.",
    );
  }
  if (!comparison.elevenlabs) {
    comparison.debug_errors.push(
      "No ElevenLabs voice benchmark JSON found. Run pnpm smoke:elevenlabs first.",
    );
  }

  await fs.mkdir(reportDir, { recursive: true });
  const file = path.join(reportDir, `voice-compare-${Date.now()}.json`);
  await fs.writeFile(file, JSON.stringify(comparison, null, 2) + "\n");
  console.log(`[smoke:voice:compare] report ${file}`);

  if (comparison.debug_errors.length > 0) {
    throw new Error(comparison.debug_errors.join(" "));
  }
}

async function latestReports() {
  let entries = [];
  try {
    entries = await fs.readdir(reportDir);
  } catch {
    return { openai: null, elevenlabs: null };
  }
  const json = entries
    .filter((name) => name.endsWith(".json"))
    .map((name) => path.join(reportDir, name));
  const parsed = [];
  for (const file of json) {
    try {
      const stat = await fs.stat(file);
      const body = JSON.parse(await fs.readFile(file, "utf8"));
      parsed.push({ file, mtimeMs: stat.mtimeMs, body });
    } catch {
      // Ignore malformed reports.
    }
  }
  parsed.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return {
    openai:
      parsed.find((r) => r.body?.provider === "openai" || r.body?.provider === "realtime")
        ?.body ?? null,
    elevenlabs: parsed.find((r) => r.body?.provider === "elevenlabs")?.body ?? null,
  };
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

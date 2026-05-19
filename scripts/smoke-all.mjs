#!/usr/bin/env node
/**
 * Run every smoke and test layer in sequence and print a pass/fail table.
 * Use this before a release / before walking away to confirm the whole
 * stack — offline AND realtime — is healthy.
 *
 *   pnpm smoke:all                   # offline + realtime (needs OPENAI_API_KEY)
 *   pnpm smoke:all --offline-only    # skip realtime smokes
 *
 * Exits non-zero if any step fails.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const offlineOnly = process.argv.includes("--offline-only");

const offlineSteps = [
  { name: "dev:doctor", cmd: ["pnpm", "dev:doctor"] },
  {
    name: "verify:drills --strict",
    cmd: ["pnpm", "verify:drills", "--", "--strict"],
  },
  { name: "build", cmd: ["pnpm", "build"] },
  { name: "test (backend unit + route, frontend pure)", cmd: ["pnpm", "test"] },
  { name: "smoke:drill-loop", cmd: ["pnpm", "smoke:drill-loop"] },
  {
    name: "smoke:browser",
    cmd: ["pnpm", "smoke:browser"],
    env: { HEADLESS: "1" },
  },
];

const realtimeSteps = [
  { name: "smoke:realtime", cmd: ["pnpm", "smoke:realtime"], realtime: true },
  {
    name: "smoke:realtime:multi",
    cmd: ["pnpm", "smoke:realtime:multi"],
    realtime: true,
  },
  {
    name: "smoke:realtime:loop",
    cmd: ["pnpm", "smoke:realtime:loop"],
    realtime: true,
  },
  {
    name: "smoke:realtime:end",
    cmd: ["pnpm", "smoke:realtime:end"],
    realtime: true,
  },
];

const steps = offlineOnly ? offlineSteps : [...offlineSteps, ...realtimeSteps];

async function run(step) {
  const startedAt = Date.now();
  return new Promise((resolve) => {
    const child = spawn(step.cmd[0], step.cmd.slice(1), {
      cwd: repoRoot,
      env: { ...process.env, ...(step.env ?? {}) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const out = [];
    const err = [];
    child.stdout.on("data", (chunk) => out.push(chunk));
    child.stderr.on("data", (chunk) => err.push(chunk));
    child.on("close", (code) => {
      resolve({
        ok: code === 0,
        durationMs: Date.now() - startedAt,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
      });
    });
    child.on("error", (e) => {
      resolve({
        ok: false,
        durationMs: Date.now() - startedAt,
        stdout: "",
        stderr: String(e),
      });
    });
  });
}

const results = [];
let aborted = false;
for (const step of steps) {
  process.stdout.write(`▶ ${step.name}…`);
  const r = await run(step);
  results.push({ step, ...r });
  process.stdout.write(
    `\r${r.ok ? "✓" : "✗"} ${step.name} (${(r.durationMs / 1000).toFixed(1)}s)\n`,
  );
  if (!r.ok && !step.realtime) {
    // Offline step failed — abort early, no point trying realtime.
    aborted = true;
    break;
  }
}

const passed = results.filter((r) => r.ok).length;
const failed = results.filter((r) => !r.ok);
console.log();
console.log(
  `${passed}/${results.length} passed${aborted ? " (aborted after offline failure)" : ""}`,
);
if (failed.length > 0) {
  console.log();
  console.log("Failures:");
  for (const r of failed) {
    console.log(`  ✗ ${r.step.name}`);
    const tail =
      r.stdout.split("\n").slice(-12).join("\n").trim() ||
      r.stderr.split("\n").slice(-12).join("\n").trim();
    if (tail) {
      console.log(
        tail
          .split("\n")
          .map((line) => `      ${line}`)
          .join("\n"),
      );
    }
  }
  process.exit(1);
}
process.exit(0);

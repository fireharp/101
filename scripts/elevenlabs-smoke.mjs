#!/usr/bin/env node
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { httpOk, waitForHttp } from "./smoke-helpers.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const backendPort = Number(process.env.BACKEND_PORT ?? 4102);
const useExistingBackend = process.env.USE_EXISTING_BACKEND === "1";
const backendUrl = useExistingBackend
  ? (process.env.BACKEND_URL ?? "http://localhost:4000")
  : `http://localhost:${backendPort}`;
const reportDir = path.join(repoRoot, "tmp", "voice-benchmarks");
const started = [];

async function main() {
  await loadDotEnv(path.join(repoRoot, ".env"));
  if (!process.env.ELEVENLABS_API_KEY) {
    throw new Error("ELEVENLABS_API_KEY is required for pnpm smoke:elevenlabs");
  }
  if (!process.env.ELEVENLABS_AGENT_ID) {
    throw new Error("ELEVENLABS_AGENT_ID is required; run pnpm elevenlabs:setup");
  }

  const startedAt = Date.now();
  const report = {
    provider: "elevenlabs",
    timestamp: new Date().toISOString(),
    agent_id: process.env.ELEVENLABS_AGENT_ID,
    agent_name: process.env.ELEVENLABS_AGENT_NAME ?? null,
    voice_id: process.env.ELEVENLABS_VOICE_ID ?? null,
    audio_fixture: null,
    timings_ms: {},
    tool_calls: [],
    transcript_length: 0,
    conversation_id: null,
    connection_duration_seconds: null,
    estimated_hosted_call_cost_usd: null,
    text_message_count: null,
    llm_usage_estimate: null,
    screenshot_path: null,
    debug_errors: [],
  };

  const dbPath = path.join(os.tmpdir(), `drill-elevenlabs-smoke-${randomUUID()}.db`);
  if (!useExistingBackend) {
    started.push(
      startProcess("backend", ["dev:backend"], {
        ...process.env,
        PORT: String(backendPort),
        DATABASE_PATH: dbPath,
        USE_OFFLINE_GRADER: "1",
      }),
    );
    await waitForHttp(`${backendUrl}/api/health`, 30000);
  } else if (!(await httpOk(`${backendUrl}/api/health`))) {
    throw new Error(`USE_EXISTING_BACKEND=1 but ${backendUrl} not healthy`);
  }

  const tokenStarted = Date.now();
  const res = await fetch(`${backendUrl}/api/elevenlabs/conversation-token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  report.timings_ms.conversation_token = Date.now() - tokenStarted;
  if (!res.ok) {
    const text = await res.text();
    report.debug_errors.push(`${res.status} ${res.statusText}: ${text}`);
    throw new Error(`ElevenLabs token smoke failed: ${report.debug_errors[0]}`);
  }
  const token = await res.json();
  if (!token.token || token.agent_id !== process.env.ELEVENLABS_AGENT_ID) {
    throw new Error("ElevenLabs token smoke returned malformed token payload");
  }
  // Browser tier is opt-in because it spends real ElevenLabs call minutes
  // and needs a live frontend + microphone fixture. The default API-only
  // tier above is enough for CI-style smoke (token mint round-trip).
  if (process.env.ELEVENLABS_SMOKE_BROWSER === "1") {
    await runBrowserTier(report, startedAt);
  }

  report.timings_ms.total = Date.now() - startedAt;
  await writeReport(report);
  console.log(
    `[smoke:elevenlabs] ok (${report.timings_ms.total}ms${report.tool_calls.length ? `, ${report.tool_calls.length} tool calls` : ""})`,
  );
}

async function runBrowserTier(report, startedAt) {
  // The browser tier always uses the vite default (5173) because
  // `pnpm dev:frontend` doesn't honor FRONTEND_PORT. If the caller needs
  // a different port, they must start vite themselves and pass
  // FRONTEND_URL pointing at it.
  const frontendUrl = process.env.FRONTEND_URL ?? "http://localhost:5173";
  const toolWaitMs = Number(process.env.ELEVENLABS_SMOKE_TOOL_WAIT_MS ?? 90000);
  const followupMs = Number(process.env.ELEVENLABS_SMOKE_FOLLOWUP_MS ?? 6000);

  if (!useExistingBackend && backendUrl !== "http://localhost:4000") {
    // The frontend's vite proxy targets localhost:4000 in dev — if we
    // booted the backend on a non-default port the UI will hit the wrong
    // host. Fail fast with an actionable hint.
    throw new Error(
      `ELEVENLABS_SMOKE_BROWSER=1 needs the frontend pointed at ${backendUrl}; either run with USE_EXISTING_BACKEND=1 (against localhost:4000) or start vite yourself with a matching proxy and pass FRONTEND_URL.`,
    );
  }
  const userProvidedFrontend = Boolean(process.env.FRONTEND_URL);
  if (!(await httpOk(frontendUrl))) {
    if (userProvidedFrontend) {
      throw new Error(
        `FRONTEND_URL=${frontendUrl} is not reachable. Start vite there before running the browser tier.`,
      );
    }
    started.push(
      startProcess("frontend", ["dev:frontend"], process.env),
    );
    await waitForHttp(frontendUrl, 30000);
  }

  const audioFile = await findAudioFile();
  if (audioFile) {
    const stat = await fs.stat(audioFile).catch(() => null);
    report.audio_fixture = audioFile
      ? {
          path: audioFile,
          bytes: stat?.size ?? null,
        }
      : null;
  }

  const { chromium } = await import("playwright");
  const browser = await chromium.launch({
    headless: process.env.HEADLESS !== "0",
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      ...(audioFile ? [`--use-file-for-fake-audio-capture=${audioFile}%noloop`] : []),
      "--autoplay-policy=no-user-gesture-required",
    ],
  });
  const consoleMessages = [];
  let page;
  try {
    const context = await browser.newContext();
    await context.grantPermissions(["microphone"], { origin: frontendUrl });
    page = await context.newPage();
    page.on("console", (msg) => {
      if (msg.type() === "error" || msg.type() === "warning") {
        consoleMessages.push(`${msg.type()}: ${msg.text()}`);
      }
    });

    await page.goto(frontendUrl, { waitUntil: "domcontentloaded" });
    await page.getByTestId("voice-provider-elevenlabs").click();
    await page.getByTestId("interaction-voice").click();
    const sessionStart = Date.now();
    await page.getByRole("button", { name: "Start session" }).click();

    await page.waitForFunction(
      () =>
        window.__drillElevenLabsDebug &&
        ["connected", "connecting"].includes(
          window.__drillElevenLabsDebug.status,
        ),
      undefined,
      { timeout: 30000 },
    );
    await page.waitForFunction(
      () => window.__drillElevenLabsDebug?.status === "connected",
      undefined,
      { timeout: 45000 },
    );
    report.timings_ms.time_to_connected = Date.now() - sessionStart;

    await page
      .waitForFunction(
        () =>
          (window.__drillElevenLabsDebug?.events ?? []).some(
            (e) => e.type === "tool_call.handled",
          ),
        undefined,
        { timeout: toolWaitMs },
      )
      .catch(() => {
        report.debug_errors.push(
          `no tool_call.handled within ${toolWaitMs}ms — agent may not have fired client tools`,
        );
      });

    // ELEVENLABS_SMOKE_REQUIRE_END=1: mirror the realtime :end tier. After
    // the first grade_attempt completes, inject "Stop. End session." via
    // __drillElevenLabsSend and assert end_session_summary fires. Proves
    // ELEVENLABS.md §9: "end_session_summary works when the user says
    // stop/end session".
    if (process.env.ELEVENLABS_SMOKE_REQUIRE_END === "1") {
      const endTimeoutMs = Number(
        process.env.ELEVENLABS_SMOKE_END_TIMEOUT_MS ?? 60000,
      );
      try {
        await page.waitForFunction(
          () => {
            const events = window.__drillElevenLabsDebug?.events ?? [];
            return events.some(
              (e) =>
                e.type === "tool_call.handled" && e.state === "grade_attempt",
            );
          },
          undefined,
          { timeout: endTimeoutMs },
        );
        await page.evaluate(() => {
          const send = window.__drillElevenLabsSend;
          if (!send) return;
          send({
            type: "conversation.item.create",
            item: {
              type: "message",
              role: "user",
              content: [
                {
                  type: "input_text",
                  text: "Stop. End session now and call end_session_summary.",
                },
              ],
            },
          });
        });
        await page.waitForFunction(
          () => {
            const events = window.__drillElevenLabsDebug?.events ?? [];
            return events.some(
              (e) =>
                e.type === "tool_call.handled" &&
                e.state === "end_session_summary",
            );
          },
          undefined,
          { timeout: endTimeoutMs },
        );
      } catch (err) {
        report.debug_errors.push(
          `end_session_summary tier failed: ${(err && err.message) || err}`,
        );
      }
    }

    // Give the agent a beat to fire follow-up tool calls (the full drill
    // turn is get_next_drill → submit_answer_transcript → grade_attempt →
    // get_next_drill again).
    await new Promise((resolve) => setTimeout(resolve, followupMs));

    const debug = await page.evaluate(() => window.__drillElevenLabsDebug);
    const toolEvents = (debug?.events ?? []).filter(
      (e) => e.type === "tool_call.handled",
    );
    report.tool_calls = toolEvents.map((e) => ({
      name: e.state ?? null,
      at_offset_ms: typeof e.at === "number" ? e.at - sessionStart : null,
    }));
    report.timings_ms.time_to_first_tool_call =
      toolEvents[0]?.at != null ? toolEvents[0].at - sessionStart : null;

    // §8 message-arrival timings: useElevenLabs records `message` debug
    // events with state=agent|user so we can measure first agent + user
    // arrivals without keeping the raw text.
    const messageEvents = (debug?.events ?? []).filter(
      (e) => e.type === "message",
    );
    const firstAgent = messageEvents.find((e) => e.state === "agent");
    const firstUser = messageEvents.find((e) => e.state === "user");
    report.timings_ms.time_to_first_agent_message =
      firstAgent?.at != null ? firstAgent.at - sessionStart : null;
    report.timings_ms.time_to_first_user_transcript =
      firstUser?.at != null ? firstUser.at - sessionStart : null;

    // ELEVENLABS.md §8 privacy: only record transcript LENGTH, never the
    // raw Mumbli transcript text.
    report.transcript_length = await page.evaluate(() => {
      const node = document.querySelector('[data-testid="transcript"]');
      return node instanceof HTMLTextAreaElement
        ? node.value.trim().length
        : 0;
    });

    const connectedEvent = (debug?.events ?? []).find(
      (e) => e.type === "session.connected",
    );
    report.conversation_id = connectedEvent?.state ?? null;
    report.debug_errors.push(...(debug?.errors ?? []));

    const screenshot = path.join(
      os.tmpdir(),
      `elevenlabs-smoke-${Date.now()}.png`,
    );
    await page.screenshot({ path: screenshot, fullPage: true }).catch(() => {});
    report.screenshot_path = screenshot;

    const stopAt = Date.now();
    await page
      .getByRole("button", { name: "Stop session" })
      .click()
      .catch(() => {});
    report.connection_duration_seconds = (stopAt - sessionStart) / 1000;
  } finally {
    report.console_messages = consoleMessages;
    await browser.close().catch(() => {});
  }
  void startedAt; // already captured in report.timestamp
}

async function findAudioFile() {
  if (process.env.ELEVENLABS_SMOKE_AUDIO) {
    return path.resolve(process.env.ELEVENLABS_SMOKE_AUDIO);
  }
  // Mirror realtime-webrtc-smoke's heuristic: pick a recent mid-length
  // Mumbli recording. Returns null if the directory or sized files are
  // missing — the browser tier still records what it can without audio,
  // exercising at least the agent's opening turn.
  const recordingsDir =
    process.env.MUMBLI_RECORDINGS_DIR ??
    path.join(os.homedir(), "Library", "Application Support", "Mumbli", "recordings");
  let entries;
  try {
    entries = await fs.readdir(recordingsDir, { withFileTypes: true });
  } catch {
    return null;
  }
  const minBytes = Number(process.env.ELEVENLABS_SMOKE_AUDIO_MIN_BYTES ?? 800_000);
  const maxBytes = Number(process.env.ELEVENLABS_SMOKE_AUDIO_MAX_BYTES ?? 3_000_000);
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".wav")) continue;
    const file = path.join(recordingsDir, entry.name);
    const stat = await fs.stat(file).catch(() => null);
    if (!stat || stat.size < minBytes || stat.size > maxBytes) continue;
    files.push({ file, mtimeMs: stat.mtimeMs });
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return files[0]?.file ?? null;
}

function startProcess(name, args, env = process.env) {
  const child = spawn("pnpm", args, {
    cwd: repoRoot,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (buf) => process.stdout.write(`[${name}] ${buf}`));
  child.stderr.on("data", (buf) => process.stderr.write(`[${name}] ${buf}`));
  child.on("exit", (code) => {
    if (code !== 0 && code !== null) {
      console.error(`[${name}] exited with ${code}`);
    }
  });
  return child;
}

async function writeReport(report) {
  await fs.mkdir(reportDir, { recursive: true });
  const file = path.join(reportDir, `elevenlabs-${Date.now()}.json`);
  await fs.writeFile(file, JSON.stringify(report, null, 2) + "\n");
  console.log(`[smoke:elevenlabs] report ${file}`);
}

async function loadDotEnv(file) {
  let body = "";
  try {
    body = await fs.readFile(file, "utf8");
  } catch {
    return;
  }
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const index = line.indexOf("=");
    if (index <= 0) continue;
    const key = line.slice(0, index).trim();
    if (process.env[key]) continue;
    const rawValue = line.slice(index + 1).trim();
    process.env[key] = rawValue.replace(/^['"]|['"]$/g, "");
  }
}

async function cleanup() {
  for (const child of started.reverse()) {
    if (child && !child.killed) {
      try {
        child.kill("SIGTERM");
      } catch {
        /* already gone */
      }
    }
  }
}

// Reap spawned children on the usual death signals too — without this a
// ctrl-c (SIGINT) leaks the backend/frontend processes we started.
process.on("SIGINT", () => {
  void cleanup().finally(() => process.exit(130));
});
process.on("SIGTERM", () => {
  void cleanup().finally(() => process.exit(143));
});
process.on("exit", () => {
  // Best-effort synchronous-style cleanup; we can't await here, but
  // SIGTERM is safe to fire fast.
  for (const child of started) {
    if (child && !child.killed) {
      try {
        child.kill("SIGTERM");
      } catch {
        /* noop */
      }
    }
  }
});

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(cleanup);

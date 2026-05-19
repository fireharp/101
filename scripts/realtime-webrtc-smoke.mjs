#!/usr/bin/env node
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const backendUrl = process.env.BACKEND_URL ?? "http://localhost:4000";
const frontendUrl = process.env.FRONTEND_URL ?? "http://localhost:5173";
const timeoutMs = Number(process.env.REALTIME_SMOKE_TIMEOUT_MS ?? 90000);

const started = [];

async function main() {
  const audioFile = await findAudioFile();
  const audio = await wavInfo(audioFile);

  if (!(await httpOk(`${backendUrl}/api/health`))) {
    started.push(startProcess("backend", ["dev:backend"]));
    await waitForHttp(`${backendUrl}/api/health`, 30000);
  }
  if (!(await httpOk(frontendUrl))) {
    started.push(startProcess("frontend", ["dev:frontend"]));
    await waitForHttp(frontendUrl, 30000);
  }

  const health = await fetchJson(`${backendUrl}/api/health`);
  if (!health.openai_configured) {
    throw new Error("Backend health says OPENAI_API_KEY is not configured");
  }

  let browser;
  let page;
  const consoleMessages = [];
  const failures = [];
  try {
    browser = await chromium.launch({
      headless: process.env.HEADLESS !== "0",
      args: [
        "--use-fake-device-for-media-stream",
        "--use-fake-ui-for-media-stream",
        `--use-file-for-fake-audio-capture=${audioFile}%noloop`,
        "--autoplay-policy=no-user-gesture-required",
      ],
    });
    const context = await browser.newContext();
    await context.grantPermissions(["microphone"], { origin: frontendUrl });
    page = await context.newPage();
    page.on("console", (msg) => {
      if (msg.type() === "error" || msg.type() === "warning") {
        consoleMessages.push(`${msg.type()}: ${msg.text()}`);
      }
    });
    page.on("pageerror", (err) => failures.push(`pageerror: ${err.message}`));
    page.on("requestfailed", (req) => {
      const url = req.url();
      if (url.includes("/api/") || url.includes("api.openai.com")) {
        failures.push(`requestfailed: ${url} ${req.failure()?.errorText ?? ""}`);
      }
    });

    await page.goto(`${frontendUrl}/?debugMic=raw`, {
      waitUntil: "domcontentloaded",
    });
    await page.getByRole("button", { name: "Start session" }).click();
    await page.getByTestId("start-voice").waitFor({ state: "visible" });
    await page.getByTestId("start-voice").click();

    await page.waitForFunction(
      () => window.__drillRealtimeDebug?.status === "connected",
      undefined,
      { timeout: 45000 },
    );
    await page.waitForFunction(
      () => {
        const node = document.querySelector('[data-testid="transcript"]');
        return node instanceof HTMLTextAreaElement && node.value.trim().length >= 8;
      },
      undefined,
      { timeout: timeoutMs },
    );

    const transcriptLength = (
      await page.getByTestId("transcript").inputValue()
    ).trim().length;

    // Give the agent a moment to fire tool calls after the user audio
    // ends — these typically arrive in the seconds after
    // `input_audio_buffer.speech_stopped`.
    const toolWaitMs = Number(process.env.REALTIME_SMOKE_TOOL_WAIT_MS ?? 20000);
    const requireToolCall = process.env.REALTIME_SMOKE_REQUIRE_TOOL !== "0";
    const toolWaitErr = await page
      .waitForFunction(
        () => {
          const events = window.__drillRealtimeDebug?.events ?? [];
          return events.some((e) => e.type === "tool_call.handled");
        },
        undefined,
        { timeout: toolWaitMs },
      )
      .then(() => null)
      .catch((err) => err);
    if (requireToolCall && toolWaitErr) {
      throw new Error(
        "Agent never called a backend tool within " +
          toolWaitMs +
          "ms; set REALTIME_SMOKE_REQUIRE_TOOL=0 to skip this assertion",
      );
    }

    const debug = await page.evaluate(() => window.__drillRealtimeDebug);
    const toolCalls = (debug?.events ?? []).filter(
      (e) => e.type === "tool_call.handled",
    );
    const screenshot = path.join(
      os.tmpdir(),
      `realtime-webrtc-smoke-${Date.now()}.png`,
    );
    await page.screenshot({ path: screenshot, fullPage: true });
    await page.getByRole("button", { name: "Stop voice" }).click().catch(() => {});

    console.log(
      JSON.stringify(
        {
          ok: true,
          audioFile,
          audio,
          transcriptLength,
          debugStatus: debug?.status ?? null,
          debugErrors: debug?.errors ?? [],
          toolCallCount: toolCalls.length,
          toolNames: [...new Set(toolCalls.map((e) => e.state))].filter(Boolean),
          recentEventTypes: (debug?.events ?? []).map((event) => event.type).slice(-25),
          rawFunctionCallEvents: debug?.rawFunctionCallEvents ?? [],
          screenshot,
          consoleMessages,
          failures,
        },
        null,
        2,
      ),
    );
  } catch (err) {
    const screenshot = page
      ? path.join(os.tmpdir(), `realtime-webrtc-smoke-fail-${Date.now()}.png`)
      : null;
    if (page && screenshot) {
      await page.screenshot({ path: screenshot, fullPage: true }).catch(() => {});
    }
    const debug = page
      ? await page.evaluate(() => window.__drillRealtimeDebug).catch(() => null)
      : null;
    console.error(
      JSON.stringify(
        {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
          audioFile,
          audio,
          screenshot,
          debug,
          consoleMessages,
          failures,
          serverLogs: started.map(({ name, tail }) => ({ name, tail })),
        },
        null,
        2,
      ),
    );
    process.exitCode = 1;
  } finally {
    await browser?.close().catch(() => {});
  }
}

function startProcess(name, args) {
  const tail = [];
  const child = spawn("pnpm", args, {
    cwd: repoRoot,
    env: { ...process.env, FORCE_COLOR: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const collect = (chunk) => {
    for (const line of chunk.toString().split(/\r?\n/).filter(Boolean)) {
      tail.push(line);
    }
    tail.splice(0, Math.max(0, tail.length - 30));
  };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  return { name, child, tail };
}

async function findAudioFile() {
  if (process.env.REALTIME_SMOKE_AUDIO) {
    return path.resolve(process.env.REALTIME_SMOKE_AUDIO);
  }
  const recordingsDir =
    process.env.MUMBLI_RECORDINGS_DIR ??
    path.join(os.homedir(), "Library", "Application Support", "Mumbli", "recordings");
  const entries = await fs.readdir(recordingsDir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".wav")) continue;
    const file = path.join(recordingsDir, entry.name);
    const stat = await fs.stat(file);
    if (stat.size >= 32000) files.push({ file, mtimeMs: stat.mtimeMs });
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  if (!files[0]) {
    throw new Error(`No usable Mumbli WAV found in ${recordingsDir}`);
  }
  return files[0].file;
}

async function wavInfo(file) {
  const stat = await fs.stat(file);
  const handle = await fs.open(file, "r");
  try {
    const header = Buffer.alloc(44);
    await handle.read(header, 0, header.length, 0);
    if (header.toString("ascii", 0, 4) !== "RIFF") {
      return { bytes: stat.size };
    }
    const channels = header.readUInt16LE(22);
    const sampleRate = header.readUInt32LE(24);
    const bitsPerSample = header.readUInt16LE(34);
    const bytesPerSecond = sampleRate * channels * (bitsPerSample / 8);
    return {
      bytes: stat.size,
      channels,
      sampleRate,
      bitsPerSample,
      durationSeconds: Number(((stat.size - 44) / bytesPerSecond).toFixed(2)),
    };
  } finally {
    await handle.close();
  }
}

async function httpOk(url) {
  try {
    const res = await fetchWithTimeout(url, 1000);
    return res.ok;
  } catch {
    return false;
  }
}

async function waitForHttp(url, maxMs) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    if (await httpOk(url)) return;
    await delay(500);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function fetchJson(url) {
  const res = await fetchWithTimeout(url, 5000);
  if (!res.ok) throw new Error(`${url} returned ${res.status}`);
  return res.json();
}

async function fetchWithTimeout(url, maxMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), maxMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shutdown() {
  for (const { child } of started) {
    if (!child.killed) child.kill("SIGTERM");
  }
}

process.on("exit", shutdown);
process.on("SIGINT", () => {
  shutdown();
  process.exit(130);
});
process.on("SIGTERM", () => {
  shutdown();
  process.exit(143);
});

main().finally(shutdown);

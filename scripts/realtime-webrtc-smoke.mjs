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
  const sourceAudioFile = await findAudioFile();
  const audioFile = await withLeadSilence(sourceAudioFile);
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

    await page.waitForFunction(
      () => window.__drillRealtimeDebug?.status === "connected",
      undefined,
      { timeout: 45000 },
    );
    await page.waitForFunction(
      () => {
        const events = window.__drillRealtimeDebug?.events ?? [];
        return events.some(
          (event) =>
            event.type === "response.output_audio_transcript.delta" ||
            event.type === "response.output_audio_transcript.done" ||
            event.type === "response.output_audio.done",
        );
      },
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
    //
    // Four assertion levels:
    //   REALTIME_SMOKE_REQUIRE_TOOL=1 (default)  → at least 1 tool call
    //   REALTIME_SMOKE_REQUIRE_MULTI_TURN=1      → at least 2 distinct
    //     tool names (proves the agent grades after the user answered)
    //   REALTIME_SMOKE_REQUIRE_LOOP=1            → at least 3 total tool
    //     calls AND get_next_drill is one of them (proves the infinite
    //     drill loop: ask → grade → ask again)
    //   REALTIME_SMOKE_REQUIRE_END=1             → after first grade,
    //     inject a faux-user "Stop. End session." message and assert
    //     end_session_summary tool call appears (proves LOCAL.md §6
    //     end_session_summary path).
    const requireEnd = process.env.REALTIME_SMOKE_REQUIRE_END === "1";
    const requireLoop =
      !requireEnd && process.env.REALTIME_SMOKE_REQUIRE_LOOP === "1";
    const requireMultiTurn =
      requireLoop || process.env.REALTIME_SMOKE_REQUIRE_MULTI_TURN === "1";
    const defaultWait = requireEnd
      ? 120000
      : requireLoop
        ? 120000
        : requireMultiTurn
          ? 90000
          : 20000;
    const toolWaitMs = Number(
      process.env.REALTIME_SMOKE_TOOL_WAIT_MS ?? defaultWait,
    );
    const requireToolCall = process.env.REALTIME_SMOKE_REQUIRE_TOOL !== "0";

    // For REQUIRE_END mode: as soon as we see grade_attempt complete,
    // inject a "stop session" user message and require
    // end_session_summary to follow. This proves the LOCAL.md §6 stop
    // path without needing a special audio recording.
    if (requireEnd) {
      // Suppress the "Next drill, please" auto-backstop so it doesn't
      // race with our "Stop. End session." message.
      await page.evaluate(() => {
        window.__drillSuppressAutoNextDrill = true;
      });
      void page
        .waitForFunction(
          () => {
            const events = window.__drillRealtimeDebug?.events ?? [];
            return events.some(
              (e) =>
                e.type === "tool_call.handled" && e.state === "grade_attempt",
            );
          },
          undefined,
          { timeout: 90000 },
        )
        .then(async () => {
          await page.evaluate(() => {
            const send = window.__drillRealtimeSend;
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
            send({ type: "response.create" });
          });
        })
        .catch(() => {
          /* timeout to find grade — smoke will fail below */
        });
    }

    const toolWaitErr = await page
      .waitForFunction(
        ({ multi, loop, end }) => {
          const events = window.__drillRealtimeDebug?.events ?? [];
          const handled = events.filter((e) => e.type === "tool_call.handled");
          if (end) {
            return handled.some((e) => e.state === "end_session_summary");
          }
          if (!multi && !loop) return handled.length >= 1;
          const names = handled.map((e) => e.state).filter(Boolean);
          if (loop) {
            return handled.length >= 3 && names.includes("get_next_drill");
          }
          return new Set(names).size >= 2;
        },
        {
          multi: requireMultiTurn,
          loop: requireLoop,
          end: requireEnd,
        },
        { timeout: toolWaitMs },
      )
      .then(() => null)
      .catch((err) => err);
    if (requireToolCall && toolWaitErr) {
      const msg = requireEnd
        ? "Agent never called end_session_summary within " +
          toolWaitMs +
          "ms after the 'stop' message. Set REALTIME_SMOKE_REQUIRE_END=0 to relax."
        : requireLoop
          ? "Agent never completed an autonomous drill loop within " +
            toolWaitMs +
            "ms (need ≥ 3 total tool calls including get_next_drill). Set REALTIME_SMOKE_REQUIRE_LOOP=0 to relax."
          : requireMultiTurn
            ? "Agent never produced 2 distinct tool calls within " +
              toolWaitMs +
              "ms (no multi-turn drill loop). Set REALTIME_SMOKE_REQUIRE_MULTI_TURN=0 to relax."
            : "Agent never called a backend tool within " +
              toolWaitMs +
              "ms; set REALTIME_SMOKE_REQUIRE_TOOL=0 to skip this assertion";
      throw new Error(msg);
    }

    const debug = await page.evaluate(() => window.__drillRealtimeDebug);
    const questionAudioEvents = (debug?.events ?? []).filter(
      (event) =>
        event.type === "response.output_audio_transcript.delta" ||
        event.type === "response.output_audio_transcript.done" ||
        event.type === "response.output_audio.done",
    );
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
          sourceAudioFile,
          audioFile,
          audio,
          transcriptLength,
          debugStatus: debug?.status ?? null,
          debugErrors: debug?.errors ?? [],
          questionAudioEventCount: questionAudioEvents.length,
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
          sourceAudioFile,
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
  // Pick a mid-length recording. Very short clips often produce empty ASR
  // transcripts, and very long clips can spend the whole wait budget before
  // the agent reaches speech_stopped. For 16 kHz mono 16-bit Mumbli output,
  // 25 s is about 800 KB and 90 s is about 2.88 MB.
  const minBytes = Number(process.env.REALTIME_SMOKE_AUDIO_MIN_BYTES ?? 800_000);
  const maxBytes = Number(process.env.REALTIME_SMOKE_AUDIO_MAX_BYTES ?? 3_000_000);
  const targetBytes = Number(
    process.env.REALTIME_SMOKE_AUDIO_TARGET_BYTES ?? 1_350_000,
  );
  const maxAgeMs = Number(
    process.env.REALTIME_SMOKE_AUDIO_MAX_AGE_MS ?? 7 * 24 * 60 * 60 * 1000,
  );
  const recordingsDir =
    process.env.MUMBLI_RECORDINGS_DIR ??
    path.join(os.homedir(), "Library", "Application Support", "Mumbli", "recordings");
  const entries = await fs.readdir(recordingsDir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".wav")) continue;
    const file = path.join(recordingsDir, entry.name);
    const stat = await fs.stat(file);
    if (maxAgeMs > 0 && Date.now() - stat.mtimeMs > maxAgeMs) continue;
    if (stat.size < minBytes) continue;
    if (stat.size > maxBytes) continue;
    files.push({ file, mtimeMs: stat.mtimeMs, bytes: stat.size });
  }
  files.sort(
    (a, b) =>
      Math.abs(a.bytes - targetBytes) - Math.abs(b.bytes - targetBytes) ||
      b.mtimeMs - a.mtimeMs,
  );
  if (!files[0]) {
    throw new Error(
      `No usable Mumbli WAV in ${recordingsDir} (need ${minBytes}-${maxBytes} bytes; override with REALTIME_SMOKE_AUDIO)`,
    );
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

async function withLeadSilence(file) {
  const leadSeconds = Number(
    process.env.REALTIME_SMOKE_LEAD_SILENCE_SECONDS ?? 12,
  );
  const tailSeconds = Number(
    process.env.REALTIME_SMOKE_TAIL_SILENCE_SECONDS ?? 5,
  );
  if (leadSeconds <= 0 && tailSeconds <= 0) return file;
  const input = await fs.readFile(file);
  if (
    input.length < 44 ||
    input.toString("ascii", 0, 4) !== "RIFF" ||
    input.toString("ascii", 8, 12) !== "WAVE"
  ) {
    return file;
  }
  const header = Buffer.from(input.subarray(0, 44));
  const channels = header.readUInt16LE(22);
  const sampleRate = header.readUInt32LE(24);
  const bitsPerSample = header.readUInt16LE(34);
  const bytesPerFrame = channels * (bitsPerSample / 8);
  const bytesPerSecond = sampleRate * bytesPerFrame;
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return file;
  const leadSilenceBytes =
    Math.floor((Math.max(0, leadSeconds) * bytesPerSecond) / bytesPerFrame) *
    bytesPerFrame;
  const tailSilenceBytes =
    Math.floor((Math.max(0, tailSeconds) * bytesPerSecond) / bytesPerFrame) *
    bytesPerFrame;
  const output = Buffer.concat([
    header,
    Buffer.alloc(leadSilenceBytes),
    input.subarray(44),
    Buffer.alloc(tailSilenceBytes),
  ]);
  header.writeUInt32LE(output.length - 8, 4);
  header.writeUInt32LE(output.length - 44, 40);
  header.copy(output, 0, 0, 44);
  const padded = path.join(os.tmpdir(), `realtime-smoke-audio-${Date.now()}.wav`);
  await fs.writeFile(padded, output);
  return padded;
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

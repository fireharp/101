#!/usr/bin/env node
/**
 * Browser drill-loop smoke. Exercises App.tsx end-to-end without mic:
 *   - Start session
 *   - Type a transcript into the textarea
 *   - Submit → assert the grade panel renders score + verdict
 *   - Next drill → assert the question text changed
 *
 * Uses the existing frontend dev server if up; otherwise starts one.
 * Runs against the offline grader so it never needs the OpenAI API.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const useExistingBackend = process.env.USE_EXISTING_BACKEND === "1";
const useExistingFrontend = process.env.USE_EXISTING_FRONTEND === "1";

const backendPort = Number(process.env.BACKEND_PORT ?? 4101);
const frontendPort = Number(process.env.FRONTEND_PORT ?? 5180);
const backendUrl = useExistingBackend
  ? (process.env.BACKEND_URL ?? "http://localhost:4000")
  : `http://localhost:${backendPort}`;
const frontendUrl = useExistingFrontend
  ? (process.env.FRONTEND_URL ?? "http://localhost:5173")
  : `http://localhost:${frontendPort}`;

const started = [];

async function main() {
  const dbPath = path.join(os.tmpdir(), `drill-browser-smoke-${randomUUID()}.db`);
  const backendEnv = {
    ...process.env,
    PORT: String(backendPort),
    DATABASE_PATH: dbPath,
    OPENAI_API_KEY: "",
    USE_OFFLINE_GRADER: "1",
    FRONTEND_ORIGIN: frontendUrl,
  };
  const frontendEnv = {
    ...process.env,
    VITE_DRILL_API_BASE: backendUrl,
  };

  if (!useExistingBackend) {
    started.push(startProcess("backend", ["dev:backend"], backendEnv));
    await waitForHttp(`${backendUrl}/api/health`, 30000);
  } else if (!(await httpOk(`${backendUrl}/api/health`))) {
    throw new Error(`USE_EXISTING_BACKEND=1 but ${backendUrl} not healthy`);
  }
  if (!useExistingFrontend) {
    // Pass --port so vite picks ours regardless of what's already up.
    started.push(
      startProcess(
        "frontend",
        [
          "--filter",
          "@drill/frontend",
          "dev",
          "--port",
          String(frontendPort),
          "--strictPort",
        ],
        frontendEnv,
      ),
    );
    await waitForHttp(frontendUrl, 30000);
  } else if (!(await httpOk(frontendUrl))) {
    throw new Error(`USE_EXISTING_FRONTEND=1 but ${frontendUrl} not reachable`);
  }

  const browser = await chromium.launch({
    headless: process.env.HEADLESS !== "0",
  });
  const consoleErrors = [];
  const pageErrors = [];
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    page.on("pageerror", (err) => pageErrors.push(err.message));

    // Force traffic to the smoke backend by intercepting /api → backendUrl.
    await context.route("**/api/**", (route) => {
      const original = new URL(route.request().url());
      const rewritten = new URL(original.pathname + original.search, backendUrl);
      route.continue({ url: rewritten.toString() });
    });

    await page.goto(frontendUrl, { waitUntil: "domcontentloaded" });

    await page.getByRole("button", { name: "Start session" }).click();
    await page.getByTestId("question").waitFor({ state: "visible", timeout: 10000 });

    const q1 = (await page.getByTestId("question").innerText()).trim();
    if (!q1) throw new Error("first drill question text is empty");

    const transcriptInput = page.getByTestId("transcript");
    await transcriptInput.fill(
      "I would use a composite B-tree index on (category_id, price). " +
        "Equality column first, ordered column second. I'd verify with " +
        "EXPLAIN ANALYZE because selectivity and the actual query shape matter.",
    );

    await page.getByTestId("submit-answer").click();
    await page.getByTestId("grade-panel").waitFor({ state: "visible", timeout: 30000 });

    const scoreText = (await page.getByTestId("grade-score").innerText()).trim();
    const verdict = (await page.getByTestId("grade-verdict").innerText()).trim();
    if (!/^\d+$/.test(scoreText)) {
      throw new Error(`grade-score is not numeric: ${scoreText}`);
    }
    if (!["pass", "borderline", "fail"].includes(verdict)) {
      throw new Error(`unexpected verdict: ${verdict}`);
    }

    // If this verdict isn't a pass, the "Try again" button should render.
    // Click it and assert the new question text equals the old one
    // (same drill, fresh attempt).
    let retryWorked = false;
    if (verdict !== "pass") {
      const retryButton = page.getByTestId("retry-drill");
      if ((await retryButton.count()) > 0) {
        await retryButton.click();
        await page.waitForFunction(
          () => {
            // After Try again, the question DOM is recreated (new key) and
            // the grade panel goes away. Detect by absence of grade-panel
            // and presence of the question.
            const grade = document.querySelector('[data-testid="grade-panel"]');
            const q = document.querySelector('[data-testid="question"]');
            return (
              !grade &&
              q instanceof HTMLElement &&
              q.innerText.trim().length > 0
            );
          },
          undefined,
          { timeout: 5000 },
        );
        const qRetry = (await page.getByTestId("question").innerText()).trim();
        if (qRetry !== q1) {
          throw new Error(
            `retry should keep the same drill text; got\n  before: ${q1.slice(0, 80)}\n  after:  ${qRetry.slice(0, 80)}`,
          );
        }
        retryWorked = true;
      }
    }

    await page.getByTestId("next-drill").click();
    // The previous grade panel should disappear and a new question appears.
    await page.waitForFunction(
      (prev) => {
        const node = document.querySelector('[data-testid="question"]');
        return (
          node instanceof HTMLElement &&
          node.innerText.trim().length > 0 &&
          node.innerText.trim() !== prev
        );
      },
      q1,
      { timeout: 10000 },
    );

    const q2 = (await page.getByTestId("question").innerText()).trim();

    // Verify the admin / review surfaces light up — these were added in
    // later rounds and never had smoke coverage. All offline.

    // 1) History panel: toggle opens, shows at least our two sessions.
    await page.getByTestId("toggle-history").click();
    await page.getByTestId("history-panel").waitFor({ state: "visible", timeout: 5000 });
    await page.waitForFunction(
      () => {
        const rows = document.querySelectorAll('[data-testid="history-row"]');
        return rows.length >= 1;
      },
      undefined,
      { timeout: 5000 },
    );
    const historyRowCount = await page.locator('[data-testid="history-row"]').count();
    await page.getByTestId("toggle-history").click(); // close

    // 2) Session audit log: toggle, expect ≥ 3 event types from the lifecycle
    // (session_created, drill_picked, grade_completed).
    await page.getByTestId("toggle-events").click();
    await page.getByTestId("events-timeline").waitFor({ state: "visible", timeout: 5000 });
    const requiredEventTypes = [
      "session_created",
      "drill_picked",
      "grade_completed",
    ];
    // Events fetch is fired by an effect; wait for the required tags.
    await page.waitForFunction(
      (required) => {
        const eventTypes = Array.from(
          document.querySelectorAll('[data-testid="event-row"]'),
        )
          .map((row) => row.querySelector(".tag")?.textContent?.trim())
          .filter(Boolean);
        return required.every((eventType) => eventTypes.includes(eventType));
      },
      requiredEventTypes,
      { timeout: 5000 },
    );
    const eventTypes = await page.evaluate(() => {
      const rows = Array.from(
        document.querySelectorAll('[data-testid="event-row"]'),
      );
      return rows
        .map((row) => {
          const tag = row.querySelector(".tag");
          return tag?.textContent?.trim() ?? null;
        })
        .filter(Boolean);
    });
    for (const t of requiredEventTypes) {
      if (!eventTypes.includes(t)) {
        throw new Error(
          `audit log missing ${t}; saw ${JSON.stringify(eventTypes)}`,
        );
      }
    }
    await page.getByTestId("toggle-events").click(); // close

    const screenshot = path.join(
      os.tmpdir(),
      `drill-loop-browser-smoke-${Date.now()}.png`,
    );
    await page.screenshot({ path: screenshot, fullPage: true });

    console.log(
      JSON.stringify(
        {
          ok: true,
          firstQuestionPreview: q1.slice(0, 80),
          secondQuestionPreview: q2.slice(0, 80),
          questionsDistinct: q1 !== q2,
          gradeScore: Number(scoreText),
          gradeVerdict: verdict,
          historyRowCount,
          auditEventTypes: eventTypes,
          retryWorked,
          screenshot,
          consoleErrors,
          pageErrors,
        },
        null,
        2,
      ),
    );
  } catch (err) {
    console.error(
      JSON.stringify(
        {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
          consoleErrors,
          pageErrors,
          serverLogs: started.map(({ name, tail }) => ({ name, tail })),
        },
        null,
        2,
      ),
    );
    process.exitCode = 1;
  } finally {
    await browser.close().catch(() => {});
  }
}

function startProcess(name, args, env) {
  const tail = [];
  const child = spawn("pnpm", args, {
    cwd: repoRoot,
    env,
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

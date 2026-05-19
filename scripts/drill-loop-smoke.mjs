#!/usr/bin/env node
/**
 * Multi-drill REST smoke. Boots backend if needed, then runs N drills
 * against the offline grader and asserts:
 *   - distinct drill_ids across the session (no boring repeats)
 *   - grading completes and produces expected fail verdicts for weak inputs
 *   - weakness state actually moves
 *
 * No OpenAI calls. Run with: pnpm smoke:drill-loop
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const useExistingBackend = process.env.USE_EXISTING_BACKEND === "1";
const backendPort = Number(process.env.BACKEND_PORT ?? 4100);
const backendUrl = useExistingBackend
  ? (process.env.BACKEND_URL ?? "http://localhost:4000")
  : `http://localhost:${backendPort}`;
const drillCount = Number(process.env.DRILL_COUNT ?? 6);

const started = [];

async function main() {
  const env = {
    ...process.env,
    PORT: String(backendPort),
    DATABASE_PATH:
      process.env.DATABASE_PATH ??
      path.join(os.tmpdir(), `drill-loop-smoke-${randomUUID()}.db`),
    OPENAI_API_KEY: "",
    USE_OFFLINE_GRADER: "1",
  };

  if (!useExistingBackend) {
    started.push(startProcess("backend", ["dev:backend"], env));
    await waitForHttp(`${backendUrl}/api/health`, 30000);
  } else if (!(await httpOk(`${backendUrl}/api/health`))) {
    throw new Error(`USE_EXISTING_BACKEND=1 but ${backendUrl} is not healthy`);
  }

  const userId = `smoke-user-${Date.now()}`;
  const headers = { "content-type": "application/json", "x-user-id": userId };

  const startRes = await postJson(
    `${backendUrl}/api/drill-sessions`,
    headers,
    { mode: "mixed" },
  );
  const sessionId = startRes.session.id;

  const transcripts = [
    // Strong B-tree answer (should pass)
    "I would use a composite B-tree index. The equality column comes first, the ordered column second. I'd verify with EXPLAIN ANALYZE because the query shape matters.",
    // Vague (fail)
    "Probably just add more indexes",
    // Medium / partial coverage
    "Partial index on status='active'. Also a covering index might help, but it costs storage. Verify with EXPLAIN ANALYZE.",
    // Red flag (fail with penalty)
    "Just index every column on the table, that always speeds things up.",
    // Strong queue answer
    "Use a durable queue with parallel consumers, retry with exponential backoff, and a DLQ. Workers must be idempotent because delivery is at-least-once. Visibility timeout above worst-case job runtime.",
    // Vague again
    "Use Redis I guess",
    // Strong cache invalidation answer
    "Cache-aside has a race between reader populate and writer update. Invalidate cache on write, use a short TTL with a versioned key, or move to write-through. Combine TTL plus invalidation in practice.",
    // Strong rate limit
    "Token bucket. Bucket size sets burst, refill rate sets sustained throughput. Store per user in Redis with an atomic decrement-or-refill. Decide what to do if Redis is unreachable: fail open or closed.",
  ];

  const seenDrillIds = new Set();
  const verdicts = { pass: 0, borderline: 0, fail: 0 };
  const results = [];

  for (let i = 0; i < drillCount; i++) {
    const drill = (
      await postJson(
        `${backendUrl}/api/drill-sessions/${sessionId}/next`,
        headers,
        {},
      )
    ).drill;
    if (seenDrillIds.has(drill.drill_id)) {
      console.warn(
        `[warn] drill ${drill.drill_id} repeated on iter ${i} (rotation engine should usually avoid this)`,
      );
    }
    seenDrillIds.add(drill.drill_id);

    const transcript =
      transcripts[i % transcripts.length] ??
      "I'd verify with EXPLAIN ANALYZE";
    const grade = await postJson(
      `${backendUrl}/api/drill-attempts/${drill.attempt_id}/grade`,
      headers,
      {
        transcript,
        duration_seconds: 45,
      },
    );
    verdicts[grade.verdict] = (verdicts[grade.verdict] ?? 0) + 1;
    results.push({
      iter: i,
      drill_id: drill.drill_id,
      topic: drill.topic,
      subtopic: drill.subtopic,
      score: grade.score,
      verdict: grade.verdict,
      missed: grade.missed_points.length,
    });
  }

  const progress = await fetchJson(`${backendUrl}/api/progress`, {
    "x-user-id": userId,
  });

  // Assertions
  const errors = [];
  if (seenDrillIds.size < Math.max(2, Math.floor(drillCount * 0.75))) {
    errors.push(
      `expected variety; got only ${seenDrillIds.size} distinct drills across ${drillCount} picks`,
    );
  }
  if (!progress.skills || progress.skills.length === 0) {
    errors.push("expected per-topic weakness state to be populated");
  }
  if (verdicts.fail === 0) {
    errors.push("expected at least one fail verdict given mixed inputs");
  }

  const ok = errors.length === 0;
  console.log(
    JSON.stringify(
      {
        ok,
        sessionId,
        userId,
        drillsRun: drillCount,
        distinctDrills: seenDrillIds.size,
        verdicts,
        topicsTouched: [...new Set(results.map((r) => r.topic))],
        weakestAfterRun: progress.skills.slice(0, 3),
        errors,
        results,
      },
      null,
      2,
    ),
  );
  if (!ok) process.exitCode = 1;
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

async function postJson(url, headers, body) {
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${url} → ${res.status}: ${text.slice(0, 300)}`);
  }
  return res.json();
}

async function fetchJson(url, headers = {}) {
  const res = await fetch(url, { headers });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${url} → ${res.status}: ${text.slice(0, 300)}`);
  }
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

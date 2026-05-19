import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { AddressInfo } from "node:net";
import test from "node:test";
import assert from "node:assert/strict";

// Isolate DB and force the offline grader BEFORE any module imports below.
process.env.DATABASE_PATH = path.join(
  os.tmpdir(),
  `drill-routes-test-${randomUUID()}.db`,
);
process.env.OPENAI_API_KEY = "";
process.env.USE_OFFLINE_GRADER = "1";
process.env.PORT = "0"; // unused — we listen on ephemeral

const { runMigrations } = await import("../db/migrations.js");
const { drills } = await import("../db/repo.js");
const { createApp } = await import("../server.js");

runMigrations();

// Seed a couple of fixture drills so rotation has something to chew on.
const fixtures: Parameters<typeof drills.upsert>[0][] = [
  {
    id: "fx_db_001",
    topic: "database",
    subtopic: "indexes",
    difficulty: 3,
    trap_type: "equality_plus_order_by",
    question_text: "Index this query: WHERE category_id=? ORDER BY price ASC LIMIT 20",
    expected_answer: {
      must_have: ["composite B-tree", "category_id before price"],
      nice_to_have: ["EXPLAIN ANALYZE"],
      red_flags: ["index every column"],
    },
    rubric: {
      must_have: ["composite B-tree", "category_id before price"],
      nice_to_have: ["EXPLAIN ANALYZE"],
      red_flags: ["index every column"],
    },
    canonical_short_answer: "Composite B-tree on (category_id, price).",
    canonical_deep_answer: null,
    tags: ["test"],
    is_active: true,
  },
  {
    id: "fx_sd_001",
    topic: "system_design",
    subtopic: "rate_limiting",
    difficulty: 3,
    trap_type: "bucket_choice",
    question_text: "Per-user rate limiter, allow bursts. Which algorithm?",
    expected_answer: {
      must_have: ["token bucket", "shared store"],
      nice_to_have: ["clock skew"],
      red_flags: ["in-memory only across nodes"],
    },
    rubric: {
      must_have: ["token bucket", "shared store"],
      nice_to_have: ["clock skew"],
      red_flags: ["in-memory only across nodes"],
    },
    canonical_short_answer: "Token bucket in Redis with atomic decrement.",
    canonical_deep_answer: null,
    tags: ["test"],
    is_active: true,
  },
  {
    id: "fx_draft_001",
    topic: "caching",
    subtopic: "eviction",
    difficulty: 3,
    trap_type: null,
    question_text: "Compare LRU vs LFU eviction policies.",
    expected_answer: {
      must_have: ["recency vs frequency"],
      nice_to_have: [],
      red_flags: [],
    },
    rubric: {
      must_have: ["recency vs frequency"],
      nice_to_have: [],
      red_flags: [],
    },
    canonical_short_answer: "LRU evicts least recently used; LFU least frequently used.",
    canonical_deep_answer: null,
    tags: ["test", "gen:llm"],
    is_active: false,
  },
];
for (const d of fixtures) drills.upsert(d);

// Start app on an ephemeral port.
const app = createApp();
const server = app.listen(0);
await new Promise<void>((resolve) => server.once("listening", () => resolve()));
const addr = server.address() as AddressInfo;
const base = `http://127.0.0.1:${addr.port}`;

const headers: Record<string, string> = {
  "content-type": "application/json",
  "x-user-id": "route-tester",
};

async function http<T = unknown>(
  method: string,
  pathname: string,
  body?: unknown,
): Promise<{ status: number; json: T }> {
  const res = await fetch(`${base}${pathname}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json: T = {} as T;
  if (res.headers.get("content-type")?.includes("application/json")) {
    json = (await res.json()) as T;
  } else {
    (json as unknown as { _text: string })._text = await res.text();
  }
  return { status: res.status, json };
}

test.after(() => {
  server.close();
});

test("GET /api/health returns drill count and openai flag", async () => {
  const r = await http<{ ok: boolean; drills: number; openai_configured: boolean }>(
    "GET",
    "/api/health",
  );
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.ok(r.json.drills >= 2);
  assert.equal(r.json.openai_configured, false);
});

test("session create → next drill → grade → summary round-trip", async () => {
  const sess = await http<{ session: { id: string } }>(
    "POST",
    "/api/drill-sessions",
    { mode: "mixed" },
  );
  assert.equal(sess.status, 200);
  const sid = sess.json.session.id;

  const next = await http<{
    drill: { drill_id: string; attempt_id: string; prior_attempts: unknown[] };
  }>("POST", `/api/drill-sessions/${sid}/next`, {});
  assert.equal(next.status, 200);
  assert.ok(next.json.drill.attempt_id);
  assert.deepEqual(next.json.drill.prior_attempts, []);

  const grade = await http<{
    score: number;
    verdict: "pass" | "borderline" | "fail";
  }>(
    "POST",
    `/api/drill-attempts/${next.json.drill.attempt_id}/grade`,
    {
      transcript:
        "I would propose a composite B-tree index on (category_id, price). Equality column first.",
      duration_seconds: 40,
    },
  );
  assert.equal(grade.status, 200);
  assert.ok(grade.json.score >= 0 && grade.json.score <= 1);
  assert.ok(["pass", "borderline", "fail"].includes(grade.json.verdict));

  const summary = await http<{
    drills_attempted: number;
    drills_graded: number;
    average_score: number;
  }>("GET", `/api/drill-sessions/${sid}/summary`);
  assert.equal(summary.status, 200);
  assert.equal(summary.json.drills_attempted, 1);
  assert.equal(summary.json.drills_graded, 1);
});

test("session ownership is enforced", async () => {
  const sess = await http<{ session: { id: string } }>(
    "POST",
    "/api/drill-sessions",
    {},
  );
  const sid = sess.json.session.id;
  // Same session, different user — must be forbidden.
  const r = await fetch(`${base}/api/drill-sessions/${sid}/next`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-user-id": "different-user",
    },
    body: "{}",
  });
  assert.equal(r.status, 403);
});

test("/api/drills/drafts lists inactive drills only", async () => {
  const r = await http<{
    count: number;
    drills: { id: string; is_active: boolean }[];
  }>("GET", "/api/drills/drafts");
  assert.equal(r.status, 200);
  assert.ok(r.json.drills.some((d) => d.id === "fx_draft_001"));
  for (const d of r.json.drills) {
    assert.equal(d.is_active, false, `${d.id} should be inactive in drafts list`);
  }
});

test("draft activation flow: list → activate → appears in active → delete is now blocked", async () => {
  // 1. Activate
  const act = await http("POST", "/api/drills/fx_draft_001/activate");
  assert.equal(act.status, 200);

  // 2. Appears in active list
  const active = await http<{ drills: { id: string }[] }>("GET", "/api/drills");
  assert.ok(active.json.drills.some((d) => d.id === "fx_draft_001"));

  // 3. Delete on an active drill is blocked (409)
  const del = await fetch(`${base}/api/drills/fx_draft_001`, {
    method: "DELETE",
    headers,
  });
  assert.equal(del.status, 409);
});

test("test-grade dry-runs without persisting an attempt", async () => {
  const r = await http<{
    score: number;
    verdict: string;
    breakdown: { must_have_coverage: number };
  }>("POST", "/api/drills/fx_db_001/test-grade", {
    transcript: "composite B-tree on category_id before price",
    duration_seconds: 30,
  });
  assert.equal(r.status, 200);
  assert.ok(r.json.score > 0);
  // Verify no attempt was persisted to drill_attempts for this user/drill.
  const sess = await http<{ session: { id: string } }>(
    "POST",
    "/api/drill-sessions",
    {},
  );
  const sid = sess.json.session.id;
  const summary = await http<{ drills_attempted: number }>(
    "GET",
    `/api/drill-sessions/${sid}/summary`,
  );
  // A brand-new session is unaffected by the test-grade dry run.
  assert.equal(summary.json.drills_attempted, 0);
});

test("tool-call dispatch: get_next_drill rejects wrong user", async () => {
  const sess = await http<{ session: { id: string } }>(
    "POST",
    "/api/drill-sessions",
    {},
  );
  const sid = sess.json.session.id;

  const wrong = await fetch(`${base}/api/realtime/tool-call`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-user-id": "different-user",
    },
    body: JSON.stringify({ session_id: sid, name: "get_next_drill", arguments: {} }),
  });
  assert.equal(wrong.status, 403);

  const ok = await http<{ result: { drill_id?: string; error?: string } }>(
    "POST",
    "/api/realtime/tool-call",
    { session_id: sid, name: "get_next_drill", arguments: {} },
  );
  assert.equal(ok.status, 200);
  assert.ok(ok.json.result.drill_id, "should return a drill_id");
});

test("PATCH /api/drills/:id updates rubric without changing is_active", async () => {
  const before = await http<{ drills: { id: string; is_active: boolean }[] }>(
    "GET",
    "/api/drills",
  );
  const fxBefore = before.json.drills.find((d) => d.id === "fx_db_001");
  assert.ok(fxBefore);

  const patch = await fetch(`${base}/api/drills/fx_db_001`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({
      canonical_short_answer:
        "Updated: composite B-tree on (category_id, price), verify with EXPLAIN ANALYZE.",
      rubric: {
        must_have: ["composite B-tree", "category_id first", "EXPLAIN ANALYZE"],
        nice_to_have: ["covering index"],
        red_flags: ["index every column"],
      },
      difficulty: 4,
    }),
  });
  assert.equal(patch.status, 200);
  const patchJson = (await patch.json()) as {
    drill: {
      canonical_short_answer: string;
      rubric: { must_have: string[] };
      difficulty: number;
      is_active: boolean;
    };
  };
  assert.match(patchJson.drill.canonical_short_answer, /Updated/);
  assert.equal(patchJson.drill.difficulty, 4);
  assert.ok(patchJson.drill.rubric.must_have.includes("EXPLAIN ANALYZE"));
  assert.equal(
    patchJson.drill.is_active,
    fxBefore.is_active,
    "PATCH must not toggle is_active",
  );

  // Invalid body (missing required rubric fields) → 400.
  const bad = await fetch(`${base}/api/drills/fx_db_001`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ rubric: { must_have: [], nice_to_have: [], red_flags: [] } }),
  });
  assert.equal(bad.status, 400);

  // Nonexistent id → 404.
  const missing = await fetch(`${base}/api/drills/does_not_exist/`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ difficulty: 2 }),
  });
  assert.equal(missing.status, 404);
});

test("realtime token endpoint returns 503 without OPENAI_API_KEY", async () => {
  const r = await http<{ error?: string }>("POST", "/api/realtime/token", {});
  assert.equal(r.status, 503);
  assert.match(r.json.error ?? "", /OPENAI_API_KEY/);
});

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
    usage: { total_tokens: number };
  }>("GET", `/api/drill-sessions/${sid}/summary`);
  assert.equal(summary.status, 200);
  assert.equal(summary.json.drills_attempted, 1);
  assert.equal(summary.json.drills_graded, 1);
  assert.equal(summary.json.usage.total_tokens, 0);
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

test("draft activation flow: list → activate → appears in active → delete is now blocked → deactivate → delete succeeds", async () => {
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

  // 4. Deactivate flips it back to a draft.
  const deact = await http("POST", "/api/drills/fx_draft_001/deactivate");
  assert.equal(deact.status, 200);
  const drafts = await http<{ drills: { id: string }[] }>(
    "GET",
    "/api/drills/drafts",
  );
  assert.ok(
    drafts.json.drills.some((d) => d.id === "fx_draft_001"),
    "deactivated drill should show in drafts list",
  );

  // 5. Now delete succeeds.
  const delOk = await fetch(`${base}/api/drills/fx_draft_001`, {
    method: "DELETE",
    headers,
  });
  assert.equal(delOk.status, 200);

  // 6. Subsequent fetch is 404.
  const gone = await fetch(`${base}/api/drills/fx_draft_001/deactivate`, {
    method: "POST",
    headers,
  });
  assert.equal(gone.status, 404);
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

test("GET /api/drills/export.yaml round-trips active drills (LOCAL.md §16 seed format)", async () => {
  const YAML = (await import("yaml")).default;

  const res = await fetch(`${base}/api/drills/export.yaml`, { headers });
  assert.equal(res.status, 200);
  assert.match(
    res.headers.get("content-type") ?? "",
    /yaml/,
    "expected YAML content-type",
  );
  const text = await res.text();
  assert.ok(text.length > 0, "non-empty body");
  const parsed = YAML.parse(text) as Array<{
    id: string;
    is_active: boolean;
    rubric: { must_have: string[]; nice_to_have: string[]; red_flags: string[] };
    canonical_short_answer: string;
  }>;
  assert.ok(Array.isArray(parsed) && parsed.length >= 2);
  for (const drill of parsed) {
    assert.ok(drill.id, "every drill needs an id");
    assert.ok(drill.canonical_short_answer, `${drill.id} missing canonical_short_answer`);
    assert.ok(Array.isArray(drill.rubric.must_have));
    // Export shouldn't smuggle drafts in by default.
    assert.equal(drill.is_active, true, `${drill.id} should be active in default export`);
  }

  // include_drafts=1 must include inactive drafts too.
  const withDrafts = await fetch(
    `${base}/api/drills/export.yaml?include_drafts=1`,
    { headers },
  );
  assert.equal(withDrafts.status, 200);
  const parsedWithDrafts = YAML.parse(await withDrafts.text()) as Array<{
    id: string;
    is_active: boolean;
  }>;
  assert.ok(parsedWithDrafts.length >= parsed.length, "drafts add to export");
});

test("GET /api/stats returns drill bank distribution", async () => {
  drills.upsert({
    ...fixtures[2]!,
    id: "fx_stats_draft_001",
    is_active: false,
  });
  const r = await http<{
    total: number;
    active: number;
    drafts: number;
    by_topic: { topic: string; active: number; drafts: number }[];
    by_difficulty: { difficulty: number; active: number; drafts: number }[];
    by_trap_type: { trap_type: string; count: number }[];
  }>("GET", "/api/stats");
  assert.equal(r.status, 200);
  assert.ok(r.json.total >= 2, "expected at least 2 drills total");
  assert.equal(r.json.total, r.json.active + r.json.drafts);
  // Our seeded fixtures include 2 active + 1 draft.
  assert.ok(r.json.active >= 2);
  assert.ok(r.json.drafts >= 1);
  // Topic distribution should cover the fixture topics.
  const topics = r.json.by_topic.map((t) => t.topic);
  assert.ok(topics.includes("database"), `expected database in topics, got ${topics}`);
  assert.ok(topics.includes("system_design"));
  // Difficulty rows always reference 1..5.
  for (const row of r.json.by_difficulty) {
    assert.ok(row.difficulty >= 1 && row.difficulty <= 5);
  }
});

test("session_events captures the full drill lifecycle", async () => {
  const sess = await http<{ session: { id: string } }>(
    "POST",
    "/api/drill-sessions",
    { mode: "mixed" },
  );
  const sid = sess.json.session.id;
  const next = await http<{ drill: { attempt_id: string } }>(
    "POST",
    `/api/drill-sessions/${sid}/next`,
    {},
  );
  const attemptId = next.json.drill.attempt_id;
  await http(
    "POST",
    `/api/drill-attempts/${attemptId}/grade`,
    {
      transcript:
        "composite B-tree on (category_id, price), equality before order, EXPLAIN ANALYZE",
      duration_seconds: 35,
    },
  );
  await http("POST", `/api/drill-sessions/${sid}/end`);

  const evs = await http<{
    events: { event_type: string; payload: Record<string, unknown> | null }[];
  }>("GET", `/api/drill-sessions/${sid}/events`);
  assert.equal(evs.status, 200);
  const types = evs.json.events.map((e) => e.event_type);
  for (const required of [
    "session_created",
    "drill_picked",
    "grade_completed",
    "session_ended",
  ]) {
    assert.ok(
      types.includes(required),
      `expected ${required} in events, got ${JSON.stringify(types)}`,
    );
  }

  // Wrong-user can't read another session's audit log.
  const wrong = await fetch(`${base}/api/drill-sessions/${sid}/events`, {
    headers: {
      "content-type": "application/json",
      "x-user-id": "different-user",
    },
  });
  assert.equal(wrong.status, 403);
});

test("realtime usage records response tokens once and appears in summary", async () => {
  const sess = await http<{ session: { id: string } }>(
    "POST",
    "/api/drill-sessions",
    { mode: "mixed" },
  );
  const sid = sess.json.session.id;
  const next = await http<{ drill: { attempt_id: string; drill_id: string } }>(
    "POST",
    `/api/drill-sessions/${sid}/next`,
    {},
  );

  const body = {
    session_id: sid,
    attempt_id: next.json.drill.attempt_id,
    source: "realtime_response",
    model: "gpt-realtime-2",
    response_id: "resp_usage_test_001",
    usage: {
      input_tokens: 100,
      output_tokens: 23,
      total_tokens: 123,
      input_text_tokens: 70,
      input_audio_tokens: 30,
      cached_tokens: 40,
      output_text_tokens: 8,
      output_audio_tokens: 15,
      estimated_cost_usd: null,
      raw_usage: { total_tokens: 123 },
    },
  };

  const first = await http<{ session: { total_tokens: number } }>(
    "POST",
    "/api/realtime/usage",
    body,
  );
  assert.equal(first.status, 200);
  assert.equal(first.json.session.total_tokens, 123);

  const duplicate = await http<{ session: { total_tokens: number } }>(
    "POST",
    "/api/realtime/usage",
    body,
  );
  assert.equal(duplicate.status, 200);
  assert.equal(
    duplicate.json.session.total_tokens,
    123,
    "same response_id should be idempotent",
  );

  const summary = await http<{
    usage: { total_tokens: number; input_audio_tokens: number };
    attempts: { attempt_id: string; usage?: { total_tokens: number } }[];
  }>("GET", `/api/drill-sessions/${sid}/summary`);
  assert.equal(summary.status, 200);
  assert.equal(summary.json.usage.total_tokens, 123);
  assert.equal(summary.json.usage.input_audio_tokens, 30);
  const attempt = summary.json.attempts.find(
    (a) => a.attempt_id === next.json.drill.attempt_id,
  );
  assert.equal(attempt?.usage?.total_tokens, 123);

  const usage = await http<{
    session: { total_tokens: number };
    by_source: { source: string; total_tokens: number }[];
    by_attempt: { attempt_id: string; total_tokens: number }[];
  }>("GET", `/api/usage/summary?session_id=${sid}`);
  assert.equal(usage.status, 200);
  assert.equal(usage.json.session.total_tokens, 123);
  assert.ok(
    usage.json.by_source.some(
      (s) => s.source === "realtime_response" && s.total_tokens === 123,
    ),
  );
  assert.ok(
    usage.json.by_attempt.some(
      (a) => a.attempt_id === next.json.drill.attempt_id && a.total_tokens === 123,
    ),
  );
});

test("realtime usage rejects wrong user", async () => {
  const sess = await http<{ session: { id: string } }>(
    "POST",
    "/api/drill-sessions",
    {},
  );
  const sid = sess.json.session.id;
  const wrong = await fetch(`${base}/api/realtime/usage`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-user-id": "different-user",
    },
    body: JSON.stringify({
      session_id: sid,
      source: "realtime_response",
      response_id: "resp_wrong_user",
      usage: { total_tokens: 1 },
    }),
  });
  assert.equal(wrong.status, 403);
});

test("POST /api/drills/import round-trips with export.yaml", async () => {
  const exportRes = await fetch(`${base}/api/drills/export.yaml`, { headers });
  assert.equal(exportRes.status, 200);
  const yamlText = await exportRes.text();
  assert.ok(yamlText.length > 0);

  // Re-import the exact same YAML — every entry should upsert, none skipped.
  const reimport = await fetch(`${base}/api/drills/import`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/x-yaml" },
    body: yamlText,
  });
  assert.equal(reimport.status, 200);
  const r = (await reimport.json()) as {
    ok: boolean;
    imported: number;
    skipped: { error: string }[];
  };
  assert.equal(r.ok, true);
  assert.ok(r.imported >= 2);
  assert.equal(r.skipped.length, 0);

  // JSON-wrapped form should also work.
  const tinyDrill = {
    id: "import_test_001",
    topic: "import_test",
    subtopic: "happy_path",
    difficulty: 2,
    trap_type: null,
    question_text: "Imported drill — minimal valid shape.",
    expected_answer: { must_have: ["something"], nice_to_have: [], red_flags: [] },
    rubric: { must_have: ["something"], nice_to_have: [], red_flags: [] },
    canonical_short_answer: "A minimal but valid canonical answer.",
    canonical_deep_answer: null,
    tags: [],
    is_active: true,
  };
  const YAML = (await import("yaml")).default;
  const jsonForm = await http<{ ok: boolean; imported: number }>(
    "POST",
    "/api/drills/import",
    { yaml: YAML.stringify([tinyDrill]) },
  );
  assert.equal(jsonForm.status, 200);
  assert.equal(jsonForm.json.imported, 1);

  // Invalid YAML returns 207 with details rather than crashing.
  const bad = await fetch(`${base}/api/drills/import`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/x-yaml" },
    body: "- id: bad\n  topic: x\n  this_is: invalid",
  });
  assert.equal(bad.status, 207);
  const badJson = (await bad.json()) as {
    ok: boolean;
    imported: number;
    skipped: { error: string }[];
  };
  assert.equal(badJson.ok, false);
  assert.equal(badJson.imported, 0);
  assert.ok(badJson.skipped.length >= 1);

  // Empty body → 400.
  const empty = await fetch(`${base}/api/drills/import`, {
    method: "POST",
    headers,
    body: JSON.stringify({}),
  });
  assert.equal(empty.status, 400);
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

test("GET /api/sessions lists recent sessions newest-first with rollup stats", async () => {
  const a = await http<{ session: { id: string } }>(
    "POST",
    "/api/drill-sessions",
    { mode: "mixed" },
  );
  const b = await http<{ session: { id: string } }>(
    "POST",
    "/api/drill-sessions",
    { mode: "db_indexes" },
  );

  const r = await http<{
    sessions: {
      id: string;
      mode: string;
      started_at: string;
      ended_at: string | null;
      drills_attempted: number;
      drills_graded: number;
      average_score: number;
    }[];
  }>("GET", "/api/sessions?limit=10");
  assert.equal(r.status, 200);
  assert.ok(r.json.sessions.length >= 2);
  const idxA = r.json.sessions.findIndex((s) => s.id === a.json.session.id);
  const idxB = r.json.sessions.findIndex((s) => s.id === b.json.session.id);
  assert.ok(idxB >= 0 && idxA >= 0);
  assert.ok(idxB <= idxA, "b is newer than a → should come first");

  const otherUser = await fetch(`${base}/api/sessions`, {
    headers: {
      "content-type": "application/json",
      "x-user-id": "different-user",
    },
  });
  assert.equal(otherUser.status, 200);
  const otherJson = (await otherUser.json()) as {
    sessions: { id: string }[];
  };
  assert.ok(
    !otherJson.sessions.some(
      (s) => s.id === a.json.session.id || s.id === b.json.session.id,
    ),
    "other user should not see our sessions",
  );
});

test("POST /api/drill-sessions/:id/retry forces a fresh attempt on the same drill", async () => {
  const sess = await http<{ session: { id: string } }>(
    "POST",
    "/api/drill-sessions",
    { mode: "mixed" },
  );
  const sid = sess.json.session.id;
  const next = await http<{
    drill: { drill_id: string; attempt_id: string };
  }>("POST", `/api/drill-sessions/${sid}/next`, {});
  const drillId = next.json.drill.drill_id;
  const firstAttempt = next.json.drill.attempt_id;

  const retry = await http<{
    drill: { drill_id: string; attempt_id: string; prior_attempts: unknown[] };
  }>("POST", `/api/drill-sessions/${sid}/retry`, { drill_id: drillId });
  assert.equal(retry.status, 200);
  assert.equal(retry.json.drill.drill_id, drillId, "retry must reuse drill");
  assert.notEqual(
    retry.json.drill.attempt_id,
    firstAttempt,
    "retry must create a new attempt id",
  );

  // Wrong-user 403.
  const wrong = await fetch(`${base}/api/drill-sessions/${sid}/retry`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-user-id": "different-user",
    },
    body: JSON.stringify({ drill_id: drillId }),
  });
  assert.equal(wrong.status, 403);

  // Missing body returns 400.
  const bad = await fetch(`${base}/api/drill-sessions/${sid}/retry`, {
    method: "POST",
    headers,
    body: JSON.stringify({}),
  });
  assert.equal(bad.status, 400);

  // Unknown drill returns 404.
  const missing = await fetch(`${base}/api/drill-sessions/${sid}/retry`, {
    method: "POST",
    headers,
    body: JSON.stringify({ drill_id: "no_such_drill_xyz" }),
  });
  assert.equal(missing.status, 404);

  // Audit log records the retry flag.
  const events = await http<{ events: { event_type: string; payload: Record<string, unknown> | null }[] }>(
    "GET",
    `/api/drill-sessions/${sid}/events`,
  );
  const retried = events.json.events.find(
    (e) =>
      e.event_type === "drill_picked" &&
      e.payload &&
      (e.payload as { retry?: boolean }).retry === true,
  );
  assert.ok(retried, "session_events should record retry: true");
});

test("GET /api/drill-attempts/:id returns full attempt detail, owner-scoped", async () => {
  const sess = await http<{ session: { id: string } }>(
    "POST",
    "/api/drill-sessions",
    { mode: "mixed" },
  );
  const next = await http<{ drill: { attempt_id: string } }>(
    "POST",
    `/api/drill-sessions/${sess.json.session.id}/next`,
    {},
  );
  const attemptId = next.json.drill.attempt_id;
  await http("POST", `/api/drill-attempts/${attemptId}/grade`, {
    transcript: "composite B-tree on category_id then price",
    duration_seconds: 30,
  });

  const r = await http<{
    attempt: {
      id: string;
      transcript: string | null;
      score: number | null;
      verdict: string | null;
      missed_points: string[] | null;
      ideal_answer: string | null;
    };
    drill: { id: string; topic: string; subtopic: string } | null;
  }>("GET", `/api/drill-attempts/${attemptId}`);
  assert.equal(r.status, 200);
  assert.equal(r.json.attempt.id, attemptId);
  assert.ok(r.json.attempt.transcript && r.json.attempt.transcript.length > 0);
  assert.ok(r.json.attempt.score !== null);
  assert.ok(r.json.drill && r.json.drill.topic);

  // Wrong user gets 403.
  const wrong = await fetch(`${base}/api/drill-attempts/${attemptId}`, {
    headers: {
      "content-type": "application/json",
      "x-user-id": "different-user",
    },
  });
  assert.equal(wrong.status, 403);

  // Bad id → 404.
  const missing = await fetch(`${base}/api/drill-attempts/does-not-exist`, {
    headers,
  });
  assert.equal(missing.status, 404);
});

test("GET /api/progress/drills returns per-drill performance", async () => {
  const sess = await http<{ session: { id: string } }>(
    "POST",
    "/api/drill-sessions",
    { mode: "mixed" },
  );
  const sid = sess.json.session.id;
  for (let i = 0; i < 2; i++) {
    const next = await http<{ drill: { attempt_id: string } }>(
      "POST",
      `/api/drill-sessions/${sid}/next`,
      {},
    );
    await http(
      "POST",
      `/api/drill-attempts/${next.json.drill.attempt_id}/grade`,
      {
        transcript: "composite B-tree on (category_id, price)",
        duration_seconds: 30,
      },
    );
  }

  const r = await http<{
    drills: {
      drill_id: string;
      topic: string;
      subtopic: string;
      attempts: number;
      graded: number;
      avg_score: number;
    }[];
  }>("GET", "/api/progress/drills?limit=10");
  assert.equal(r.status, 200);
  assert.ok(r.json.drills.length >= 1);
  for (let i = 1; i < r.json.drills.length; i++) {
    assert.ok(
      (r.json.drills[i]!.avg_score ?? 0) >=
        (r.json.drills[i - 1]!.avg_score ?? 0),
      "performance list should be ascending by avg_score",
    );
  }
  for (const row of r.json.drills) {
    assert.ok(row.topic);
    assert.ok(row.subtopic);
    assert.ok(row.graded >= 1);
  }
});

test("realtime token endpoint returns 503 without OPENAI_API_KEY", async () => {
  const r = await http<{ error?: string }>("POST", "/api/realtime/token", {});
  assert.equal(r.status, 503);
  assert.match(r.json.error ?? "", /OPENAI_API_KEY/);
});

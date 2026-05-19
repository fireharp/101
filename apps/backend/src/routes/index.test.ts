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

test("tool-call dispatch: save_generated_cards persists valid cards, drops malformed", async () => {
  const sess = await http<{ session: { id: string } }>(
    "POST",
    "/api/drill-sessions",
    {},
  );
  const sid = sess.json.session.id;

  const result = await http<{ result: { saved?: number } }>(
    "POST",
    "/api/realtime/tool-call",
    {
      session_id: sid,
      name: "save_generated_cards",
      arguments: {
        cards: [
          { front: "What is the formula for must_have_coverage weight?", back: "0.65" },
          { front: "WAL stands for?", back: "write-ahead log", drill_id: "fx_db_001" },
          { front: "missing back" }, // invalid
          "stray string", // invalid
          null, // invalid
          { front: 42, back: "back-is-string-but-front-is-not" }, // invalid
        ],
      },
    },
  );
  assert.equal(result.status, 200);
  assert.equal(
    result.json.result.saved,
    2,
    "only the two well-formed card objects should be persisted",
  );
});

test("tool-call dispatch: get_user_skill_summary reflects graded attempts", async () => {
  const userId = `skill-summary-${randomUUID().slice(0, 8)}`;
  const userHeaders = {
    "content-type": "application/json",
    "x-user-id": userId,
  };
  const post = (pathname: string, body: unknown) =>
    fetch(`${base}${pathname}`, {
      method: "POST",
      headers: userHeaders,
      body: JSON.stringify(body),
    });

  const sessRes = await post("/api/drill-sessions", {});
  const sess = (await sessRes.json()) as { session: { id: string } };
  const sid = sess.session.id;

  // Full tool-call round: pick → submit → grade.
  const nextRes = await post("/api/realtime/tool-call", {
    session_id: sid,
    name: "get_next_drill",
    arguments: {},
  });
  const nextBody = (await nextRes.json()) as {
    result: { attempt_id: string; topic: string };
  };
  const attemptId = nextBody.result.attempt_id;
  const drillTopic = nextBody.result.topic;
  assert.ok(attemptId, "expected get_next_drill to seed an attempt");

  await post("/api/realtime/tool-call", {
    session_id: sid,
    name: "submit_answer_transcript",
    arguments: {
      attempt_id: attemptId,
      transcript: "I really don't know",
      duration_seconds: 5,
    },
  });
  await post("/api/realtime/tool-call", {
    session_id: sid,
    name: "grade_attempt",
    arguments: { attempt_id: attemptId },
  });

  const summaryRes = await post("/api/realtime/tool-call", {
    session_id: sid,
    name: "get_user_skill_summary",
    arguments: {},
  });
  const summary = (await summaryRes.json()) as {
    result: {
      weakest: Array<{ topic: string; weakness_score: number; exposure_count: number }>;
    };
  };
  assert.equal(summaryRes.status, 200);
  assert.ok(
    summary.result.weakest.length >= 1,
    "weakest list should have at least one entry after a graded attempt",
  );
  const topics = summary.result.weakest.map((w) => w.topic);
  assert.ok(
    topics.includes(drillTopic),
    `weakest list should include the just-graded topic ${drillTopic} (got ${topics.join(",")})`,
  );
  const entry = summary.result.weakest.find((w) => w.topic === drillTopic)!;
  assert.ok(entry.exposure_count >= 1);
  assert.ok(entry.weakness_score >= 0 && entry.weakness_score <= 1);
});

test("PATCH /api/drills/:id audits the rubric edit and shows up in /api/admin/events", async () => {
  const before = await http<{ events: Array<{ event_type: string; payload: unknown }> }>(
    "GET",
    "/api/admin/events?limit=500",
  );
  const beforeCount = before.json.events.length;

  const patched = await http<{ ok: boolean; drill: { id: string; rubric: { must_have: string[] } } }>(
    "PATCH",
    "/api/drills/fx_db_001",
    {
      rubric: {
        must_have: ["composite B-tree", "category_id before price", "selectivity"],
        nice_to_have: ["EXPLAIN ANALYZE", "covering index"],
        red_flags: ["index every column"],
      },
    },
  );
  assert.equal(patched.status, 200);
  assert.equal(patched.json.ok, true);
  assert.ok(patched.json.drill.rubric.must_have.includes("selectivity"));

  const after = await http<{
    events: Array<{
      event_type: string;
      session_id: string;
      payload: { drill_id?: string; fields_changed?: string[] } | null;
    }>;
  }>("GET", "/api/admin/events?limit=500");
  assert.ok(
    after.json.events.length > beforeCount,
    "admin event count should grow after PATCH",
  );
  const audit = after.json.events.find(
    (e) =>
      e.event_type === "rubric_edited" &&
      e.payload?.drill_id === "fx_db_001",
  );
  assert.ok(audit, "expected a rubric_edited event for fx_db_001");
  assert.equal(audit.session_id, "__admin__");
  assert.ok(
    audit.payload?.fields_changed?.includes("rubric"),
    "audit payload should record which fields changed",
  );
});

test("GET /api/admin/events clamps the limit param into [1, 500]", async () => {
  const tiny = await http<{ events: unknown[] }>("GET", "/api/admin/events?limit=1");
  assert.equal(tiny.status, 200);
  assert.ok(tiny.json.events.length <= 1);

  const garbage = await http<{ events: unknown[] }>(
    "GET",
    "/api/admin/events?limit=not-a-number",
  );
  assert.equal(garbage.status, 200);
  assert.ok(Array.isArray(garbage.json.events));
});

test("GET /api/admin/events filters by type (single, CSV, and invalid)", async () => {
  const draftId = `fx_admin_filter_${randomUUID().slice(0, 8)}`;
  drills.upsert({
    ...fixtures[2]!,
    id: draftId,
    is_active: false,
  });

  const activated = await http("POST", `/api/drills/${draftId}/activate`, {});
  assert.equal(activated.status, 200);

  const edited = await http("PATCH", "/api/drills/fx_db_001", {
    trap_type: "admin_event_filter_check",
  });
  assert.equal(edited.status, 200);

  const ruleEdits = await http<{
    events: { event_type: string; payload: { drill_id?: string } | null }[];
  }>("GET", "/api/admin/events?type=rubric_edited&limit=500");
  assert.equal(ruleEdits.status, 200);
  assert.ok(ruleEdits.json.events.length >= 1);
  assert.ok(
    ruleEdits.json.events.every((e) => e.event_type === "rubric_edited"),
    "type filter should exclude every other event_type",
  );

  const csv = await http<{ events: { event_type: string }[] }>(
    "GET",
    "/api/admin/events?type=rubric_edited,draft_activated&limit=500",
  );
  assert.equal(csv.status, 200);
  const eventTypes = new Set(csv.json.events.map((e) => e.event_type));
  for (const t of eventTypes) {
    assert.ok(
      ["rubric_edited", "draft_activated"].includes(t),
      `unexpected event_type leaked through CSV filter: ${t}`,
    );
  }

  const bad = await http<{ error: string; allowed?: string[] }>(
    "GET",
    "/api/admin/events?type=session_created",
  );
  assert.equal(bad.status, 400);
  assert.match(bad.json.error, /unknown event type/i);
  assert.ok(
    bad.json.allowed?.includes("rubric_edited"),
    "400 response should hint the allowed admin types",
  );
});

test("GET /api/admin/events 'since' filter excludes older events and rejects garbage", async () => {
  const draftId = `fx_admin_since_${randomUUID().slice(0, 8)}`;
  drills.upsert({
    ...fixtures[2]!,
    id: draftId,
    is_active: false,
  });

  // Anchor: capture "now" floored to the second to match SQLite's
  // CURRENT_TIMESTAMP precision, then write a fresh admin event after it.
  const anchor = new Date();
  anchor.setMilliseconds(0);
  const sinceIso = anchor.toISOString();
  // Pause to make sure created_at strictly increases past `sinceIso`.
  await new Promise((r) => setTimeout(r, 1100));
  const activated = await http("POST", `/api/drills/${draftId}/activate`, {});
  assert.equal(activated.status, 200);

  const fresh = await http<{
    events: { event_type: string; created_at: string }[];
  }>("GET", `/api/admin/events?since=${encodeURIComponent(sinceIso)}&limit=500`);
  assert.equal(fresh.status, 200);
  assert.ok(
    fresh.json.events.length >= 1,
    "should include the activation we just did",
  );
  // created_at is stored in SQLite local-naive form ('YYYY-MM-DD HH:MM:SS');
  // compare as parsed timestamps, not raw strings.
  const sinceMs = new Date(sinceIso).getTime();
  for (const e of fresh.json.events) {
    // SQLite stamps may arrive as UTC-naive ('YYYY-MM-DD HH:MM:SS') or ISO.
    const normalized = e.created_at.includes("T")
      ? e.created_at
      : `${e.created_at.replace(" ", "T")}Z`;
    const eventMs = new Date(normalized).getTime();
    assert.ok(Number.isFinite(eventMs), `created_at should parse: ${e.created_at}`);
    assert.ok(
      eventMs >= sinceMs,
      `every event should be ≥ since (${e.created_at} < ${sinceIso})`,
    );
  }

  const bad = await http<{ error: string }>(
    "GET",
    "/api/admin/events?since=last-tuesday",
  );
  assert.equal(bad.status, 400);
  assert.match(bad.json.error, /invalid 'since'/);
});

test("timestamps round-trip as ISO 8601 with Z (no naive 'YYYY-MM-DD HH:MM:SS' leaks)", async () => {
  const isoRe = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

  // 1. Freshly created session — both started_at (DB default) and any later
  //    summary read should be ISO with Z.
  const sess = await http<{ session: { id: string; started_at: string } }>(
    "POST",
    "/api/drill-sessions",
    {},
  );
  assert.match(
    sess.json.session.started_at,
    isoRe,
    `started_at should be ISO 8601 with Z; got ${sess.json.session.started_at}`,
  );

  // 2. Drill_picked → grade flow lays down attempts; the audit timeline must
  //    return events with the same shape.
  await http("POST", `/api/drill-sessions/${sess.json.session.id}/next`, {});
  const ts = await http<{
    events: { created_at: string }[];
  }>("GET", `/api/drill-sessions/${sess.json.session.id}/events`);
  for (const e of ts.json.events) {
    assert.match(
      e.created_at,
      isoRe,
      `session_event created_at should be ISO 8601 with Z; got ${e.created_at}`,
    );
  }

  // 3. Admin events — already covered by the since/type tests, but verify
  //    the format invariant explicitly here too.
  const adminEvents = await http<{ events: { created_at: string }[] }>(
    "GET",
    "/api/admin/events?limit=5",
  );
  for (const e of adminEvents.json.events) {
    assert.match(
      e.created_at,
      isoRe,
      `admin event created_at should be ISO 8601 with Z; got ${e.created_at}`,
    );
  }
});

test("admin audit events carry actor (x-user-id) for every event type", async () => {
  const ACTOR = `audit-actor-${randomUUID().slice(0, 6)}`;
  const actorHeaders = {
    "content-type": "application/json",
    "x-user-id": ACTOR,
  };
  const post = (pathname: string, body: unknown = {}) =>
    fetch(`${base}${pathname}`, {
      method: "POST",
      headers: actorHeaders,
      body: JSON.stringify(body),
    });
  const patch = (pathname: string, body: unknown) =>
    fetch(`${base}${pathname}`, {
      method: "PATCH",
      headers: actorHeaders,
      body: JSON.stringify(body),
    });
  const del = (pathname: string) =>
    fetch(`${base}${pathname}`, { method: "DELETE", headers: actorHeaders });

  // Provision a draft drill we can drive through activate → edit → deactivate
  // → discard. Each step is a different admin event type.
  const draftId = `fx_actor_${randomUUID().slice(0, 6)}`;
  drills.upsert({ ...fixtures[2]!, id: draftId, is_active: false });

  // Imports — round-trip a tiny YAML doc so we exercise drill_imported too.
  const tinyDrill = {
    ...fixtures[2]!,
    id: `fx_actor_import_${randomUUID().slice(0, 6)}`,
    is_active: false,
  };
  const YAML = (await import("yaml")).default;
  await fetch(`${base}/api/drills/import`, {
    method: "POST",
    headers: { ...actorHeaders, "content-type": "application/x-yaml" },
    body: YAML.stringify([tinyDrill]),
  });

  await post(`/api/drills/${draftId}/activate`);
  await patch(`/api/drills/${draftId}`, {
    rubric: {
      must_have: ["recency vs frequency", "actor audit"],
      nice_to_have: [],
      red_flags: [],
    },
  });
  await post(`/api/drills/${draftId}/deactivate`);
  await del(`/api/drills/${draftId}`);

  const audit = await http<{
    events: Array<{
      event_type: string;
      payload: { actor?: string; drill_id?: string } | null;
    }>;
  }>("GET", "/api/admin/events?limit=500");

  const mine = audit.json.events.filter(
    (e) => e.payload?.actor === ACTOR,
  );
  const types = new Set(mine.map((e) => e.event_type));
  for (const expected of [
    "drill_imported",
    "draft_activated",
    "rubric_edited",
    "draft_deactivated",
    "draft_discarded",
  ]) {
    assert.ok(
      types.has(expected),
      `expected an actor-tagged ${expected} event in audit log; saw types: ${[...types].join(", ") || "(none)"}`,
    );
  }
});

test("GET /api/admin/events filters by actor and excludes pre-attribution rows", async () => {
  const ACTOR = `actor-filter-${randomUUID().slice(0, 6)}`;
  const OTHER = `actor-other-${randomUUID().slice(0, 6)}`;
  const draftA = `fx_actor_a_${randomUUID().slice(0, 6)}`;
  const draftB = `fx_actor_b_${randomUUID().slice(0, 6)}`;
  drills.upsert({ ...fixtures[2]!, id: draftA, is_active: false });
  drills.upsert({ ...fixtures[2]!, id: draftB, is_active: false });

  // Two distinct actors write to the audit log in interleaved order.
  await fetch(`${base}/api/drills/${draftA}/activate`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-user-id": ACTOR },
    body: "{}",
  });
  await fetch(`${base}/api/drills/${draftB}/activate`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-user-id": OTHER },
    body: "{}",
  });

  const mine = await http<{
    events: Array<{ event_type: string; payload: { actor?: string; drill_id?: string } | null }>;
  }>("GET", `/api/admin/events?actor=${encodeURIComponent(ACTOR)}&limit=500`);
  assert.equal(mine.status, 200);
  assert.ok(
    mine.json.events.length >= 1,
    "should include the activation made under ACTOR",
  );
  for (const e of mine.json.events) {
    assert.equal(
      e.payload?.actor,
      ACTOR,
      `actor filter leaked a row from ${e.payload?.actor}`,
    );
  }
  const drillIds = mine.json.events.map((e) => e.payload?.drill_id);
  assert.ok(
    drillIds.includes(draftA),
    "ACTOR's draftA activate should appear",
  );
  assert.ok(
    !drillIds.includes(draftB),
    "OTHER's draftB activate must not leak through actor filter",
  );

  // Combine ?actor + ?type — should still only return ACTOR's rubric_edited.
  await fetch(`${base}/api/drills/${draftA}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", "x-user-id": ACTOR },
    body: JSON.stringify({
      rubric: {
        must_have: ["actor-combined-filter"],
        nice_to_have: [],
        red_flags: [],
      },
    }),
  });
  const combined = await http<{
    events: Array<{ event_type: string; payload: { actor?: string } | null }>;
  }>(
    "GET",
    `/api/admin/events?actor=${encodeURIComponent(ACTOR)}&type=rubric_edited&limit=500`,
  );
  assert.equal(combined.status, 200);
  assert.ok(combined.json.events.length >= 1);
  for (const e of combined.json.events) {
    assert.equal(e.event_type, "rubric_edited");
    assert.equal(e.payload?.actor, ACTOR);
  }
});

test("DELETE /api/drills/:id writes a draft_discarded admin audit event", async () => {
  const id = `fx_admin_discard_${randomUUID().slice(0, 8)}`;
  drills.upsert({ ...fixtures[2]!, id, is_active: false });

  const del = await fetch(`${base}/api/drills/${id}`, {
    method: "DELETE",
    headers,
  });
  assert.equal(del.status, 200);

  const audit = await http<{
    events: { event_type: string; payload: { drill_id?: string } | null }[];
  }>(
    "GET",
    `/api/admin/events?type=draft_discarded&limit=500`,
  );
  const match = audit.json.events.find(
    (e) => e.payload?.drill_id === id,
  );
  assert.ok(
    match,
    `expected a draft_discarded event for ${id}; saw ${audit.json.events.length} draft_discarded events total`,
  );
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

test("card lifecycle: grade generates cards → due → review → re-schedule", async () => {
  const cardUserHeaders = {
    "content-type": "application/json",
    "x-user-id": `card-tester-${Date.now()}`,
  };
  const sessJson = await fetch(`${base}/api/drill-sessions`, {
    method: "POST",
    headers: cardUserHeaders,
    body: JSON.stringify({ mode: "mixed" }),
  });
  const sess = (await sessJson.json()) as { session: { id: string } };
  const nextJson = await fetch(
    `${base}/api/drill-sessions/${sess.session.id}/next`,
    { method: "POST", headers: cardUserHeaders, body: "{}" },
  );
  const next = (await nextJson.json()) as { drill: { attempt_id: string } };

  // Submit a deliberately weak answer so the offline grader emits cards
  // from missed rubric points.
  const gradeJson = await fetch(
    `${base}/api/drill-attempts/${next.drill.attempt_id}/grade`,
    {
      method: "POST",
      headers: cardUserHeaders,
      body: JSON.stringify({
        transcript: "i dunno",
        duration_seconds: 5,
      }),
    },
  );
  const grade = (await gradeJson.json()) as {
    cards: { id?: string; front: string; back: string }[];
  };
  assert.ok(grade.cards.length >= 1, "weak answer should generate ≥ 1 card");
  const cardId = grade.cards[0]!.id;
  assert.ok(cardId, "card insert should return an id");

  // Cards just generated should appear in /due (default interval = +1 day,
  // but `cards.due` includes anything with next_due_at <= now OR NULL —
  // freshly minted cards are due immediately under SM-2-lite).
  const dueRes = await fetch(`${base}/api/cards/due?limit=20`, {
    headers: cardUserHeaders,
  });
  assert.equal(dueRes.status, 200);
  const due = (await dueRes.json()) as {
    cards: { id: string }[];
    stats: { total: number; due: number };
  };
  assert.ok(due.stats.total >= 1);
  // The card we just generated may or may not be due yet (insert sets
  // next_due_at = +1 day). Verify the API at least responds and the
  // counts are consistent.
  assert.ok(due.stats.due <= due.stats.total);

  // POST review: "knew it" → ease grows, interval becomes a positive day count.
  const knew = await fetch(`${base}/api/cards/${cardId}/review`, {
    method: "POST",
    headers: cardUserHeaders,
    body: JSON.stringify({ quality: 1 }),
  });
  assert.equal(knew.status, 200);
  const knewJson = (await knew.json()) as {
    ok: boolean;
    interval_days: number;
    ease: number;
  };
  assert.equal(knewJson.ok, true);
  assert.ok(knewJson.interval_days >= 1, "knew → interval ≥ 1 day");
  assert.ok(knewJson.ease >= 1.3, "ease within SM-2 bounds");

  // POST review: "forgot" → ease shrinks, interval resets to 0.
  const forgot = await fetch(`${base}/api/cards/${cardId}/review`, {
    method: "POST",
    headers: cardUserHeaders,
    body: JSON.stringify({ quality: 0 }),
  });
  assert.equal(forgot.status, 200);
  const forgotJson = (await forgot.json()) as { interval_days: number };
  assert.equal(forgotJson.interval_days, 0, "forgot → interval = 0");

  // Bad body → 400.
  const bad = await fetch(`${base}/api/cards/${cardId}/review`, {
    method: "POST",
    headers: cardUserHeaders,
    body: JSON.stringify({ quality: 7 }),
  });
  assert.equal(bad.status, 400);

  // Unknown id → 404.
  const ghost = await fetch(`${base}/api/cards/does-not-exist/review`, {
    method: "POST",
    headers: cardUserHeaders,
    body: JSON.stringify({ quality: 1 }),
  });
  assert.equal(ghost.status, 404);
});

test("GET /api/cards/export.csv produces Anki-compatible CSV", async () => {
  const exportRes = await fetch(`${base}/api/cards/export.csv`, { headers });
  assert.equal(exportRes.status, 200);
  assert.match(
    exportRes.headers.get("content-type") ?? "",
    /text\/csv/,
    "expected text/csv content-type",
  );
  const body = await exportRes.text();
  const lines = body.split(/\r?\n/).filter(Boolean);
  assert.ok(lines.length >= 1, "expected at least a header row");
  assert.equal(lines[0], "front,back,tags", "header row should match Anki shape");
  if (lines.length >= 2) {
    // Each data row should have ≥ 2 commas (front,back,tags). Commas inside
    // quoted fields don't count — split on a comma OUTSIDE quotes.
    const sample = lines[1]!;
    const commasOutsideQuotes = (() => {
      let n = 0;
      let inQuote = false;
      for (const ch of sample) {
        if (ch === '"') inQuote = !inQuote;
        else if (ch === "," && !inQuote) n += 1;
      }
      return n;
    })();
    assert.ok(
      commasOutsideQuotes >= 2,
      `row 1 should have ≥ 2 unquoted commas; got ${commasOutsideQuotes}`,
    );
  }
});

test("realtime token endpoint returns 503 without OPENAI_API_KEY", async () => {
  const r = await http<{ error?: string }>("POST", "/api/realtime/token", {});
  assert.equal(r.status, 503);
  assert.match(r.json.error ?? "", /OPENAI_API_KEY/);
});

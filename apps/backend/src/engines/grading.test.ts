import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

process.env.DATABASE_PATH = path.join(
  os.tmpdir(),
  `drill-grading-test-${randomUUID()}.db`,
);
process.env.OPENAI_API_KEY = "";
process.env.USE_OFFLINE_GRADER = "1";

const { runMigrations } = await import("../db/migrations.js");
runMigrations();

const { gradeAttempt } = await import("./grading.js");
const { Drill } = await import("./grading-test-fixtures.js");

test("offline grader fails a clearly empty / off-topic answer", async () => {
  const result = await gradeAttempt({
    drill: Drill.indexQuestion(),
    transcript: "I really don't know",
    duration_seconds: 8,
  });
  assert.equal(result.verdict, "fail");
  assert.ok(result.score < 0.5, `expected low score, got ${result.score}`);
  assert.ok(result.missed_points.length > 0);
});

test("offline grader scores a strong rubric-aligned answer well", async () => {
  const result = await gradeAttempt({
    drill: Drill.indexQuestion(),
    transcript:
      "I would use a composite B-tree index on (category_id, price). Equality column category_id comes before the ordered price column. I'd verify with EXPLAIN ANALYZE because the query shape and selectivity matter. If most rows are active, a partial index on status='active' helps further.",
    duration_seconds: 55,
  });
  assert.ok(
    result.score >= 0.7,
    `expected high score, got ${result.score} for transcript`,
  );
  assert.ok(["pass", "borderline"].includes(result.verdict));
  // All must-have rubric items should be covered.
  assert.equal(result.breakdown.must_have_coverage, 1);
});

test("offline grader gives semantic partial credit for API rollout wording", async () => {
  const result = await gradeAttempt({
    drill: Drill.apiVersioningQuestion(),
    transcript:
      "I'll add a new one, keep the old one for a while, keep monitoring the old one, when the old one is at some 0.01% of usage, I will just deprecate it, but to be honest I don't have to deprecate it at all, it just may happen at some point.",
    duration_seconds: 45,
  });
  assert.equal(result.verdict, "borderline");
  assert.ok(result.score >= 0.6, `expected partial credit, got ${result.score}`);
  assert.ok(
    result.covered_points?.some((point) => point.includes("dual emit")),
    `expected covered rollout point, got ${result.covered_points?.join(", ")}`,
  );
  assert.ok(
    result.missed_points.some((point) => point.includes("timeline")),
    `expected clearer timeline miss, got ${result.missed_points.join(", ")}`,
  );
});

test("offline grader credits keepalive spelling for HTTP connection reuse", async () => {
  const result = await gradeAttempt({
    drill: Drill.keepAlivePoolQuestion(),
    transcript:
      "So there is keepalive so we can reuse same connections and cache, cache opened connections have a connection pool.",
    duration_seconds: 32,
  });
  assert.ok(
    result.covered_points?.some((point) => point.includes("keep-alive")),
    `expected keep-alive coverage, got ${result.covered_points?.join(", ")}`,
  );
  assert.ok(
    !result.missed_points.includes("reuse connections via HTTP keep-alive"),
    `keepalive should not be missed, got ${result.missed_points.join(", ")}`,
  );
  assert.ok(
    result.missed_points.some((point) => point.includes("TLS handshake")),
    `expected TLS handshake miss, got ${result.missed_points.join(", ")}`,
  );
});

test("offline grader applies red-flag penalty for dangerous phrasing", async () => {
  const result = await gradeAttempt({
    drill: Drill.indexQuestion(),
    transcript:
      "Easy. Just index every column on the table, that always speeds things up. Use a hash index for ordering too.",
    duration_seconds: 30,
  });
  // Both red flags should hit → at least 0.30 penalty.
  assert.ok(
    result.breakdown.red_flag_penalty >= 0.25,
    `expected red flag penalty, got ${result.breakdown.red_flag_penalty}`,
  );
  assert.equal(result.verdict, "fail");
});

test("offline grader generates cards from missed points", async () => {
  const result = await gradeAttempt({
    drill: Drill.indexQuestion(),
    transcript: "just put an index on the price column and call it done",
    duration_seconds: 12,
  });
  assert.ok(result.cards.length > 0, "should generate at least one card");
  for (const card of result.cards) {
    assert.equal(card.drill_id, "db_index_test");
    assert.equal(card.topic, "database");
    assert.ok(card.front.length > 0);
    assert.ok(card.back.length > 0);
  }
});

test("offline grader penalises overly short answers via clarity", async () => {
  const result = await gradeAttempt({
    drill: Drill.indexQuestion(),
    transcript: "B-tree",
    duration_seconds: 3,
  });
  assert.ok(
    result.breakdown.answer_clarity <= 0.4,
    `short answer should have low clarity, got ${result.breakdown.answer_clarity}`,
  );
});

test("rapid grader passes complete 30-second definition/caveat/example answers", async () => {
  const result = await gradeAttempt({
    drill: Drill.rapidSecurityQuestion(),
    transcript:
      "SQL injection is when user input changes the structure of a query. Use parameterized queries and do not interpolate values into SQL strings. The caveat is dynamic table or column names need an allowlist. For example, an email field containing quote OR 1 equals 1 should stay a value, not become SQL.",
    duration_seconds: 32,
  });
  assert.equal(result.verdict, "pass");
  assert.ok(result.score >= 0.8, `expected pass score, got ${result.score}`);
  assert.equal(result.breakdown.tradeoff_coverage, 1);
});

test("rapid grader caps missing caveat answers at borderline", async () => {
  const result = await gradeAttempt({
    drill: Drill.rapidSecurityQuestion(),
    transcript:
      "SQL injection is user input changing query structure. Use parameterized queries and never interpolate user values into SQL. For example, an attacker puts OR 1 equals 1 in an email field and it remains a value.",
    duration_seconds: 28,
  });
  assert.equal(result.verdict, "borderline");
  assert.ok(
    result.missed_points.includes("caveat/tradeoff"),
    `expected caveat miss, got ${result.missed_points.join(", ")}`,
  );
});

test("rapid grader credits SQL injection answers that mention parameters or ORM", async () => {
  const result = await gradeAttempt({
    drill: Drill.rapidRubySqlInjectionQuestion(),
    transcript:
      "So it's an SQL injection possibility and the fix would be to sanitize email and use parameterized queries and or ORMs and or frameworks so that you don't get direct parameters and you get them from something like serializers and Django.",
    duration_seconds: 35,
  });
  assert.equal(result.verdict, "borderline");
  assert.ok(result.score >= 0.6, `expected borderline credit, got ${result.score}`);
  assert.ok(
    result.covered_points?.includes("use parameterized queries or ORM binding"),
    `expected parameterized/ORM credit, got ${result.covered_points?.join(", ")}`,
  );
  assert.ok(
    result.missed_points.includes("user input becomes SQL code not data"),
    `expected exploit mechanism miss, got ${result.missed_points.join(", ")}`,
  );
});

test("rapid grader fails dangerous red flags", async () => {
  const result = await gradeAttempt({
    drill: Drill.rapidSecurityQuestion(),
    transcript:
      "SQL injection is about bad SQL. Escaping alone is enough in practice, like replacing quotes before concatenating the query string.",
    duration_seconds: 22,
  });
  assert.equal(result.verdict, "fail");
  assert.ok(result.score < 0.6, `expected fail score, got ${result.score}`);
  assert.ok(result.breakdown.red_flag_penalty > 0);
});

test("rapid grader credits debugging answers for logs instrumentation and reproducibility", async () => {
  const result = await gradeAttempt({
    drill: Drill.rapidDebuggingQuestion(),
    transcript:
      "So my main debugging pass would be to have logs on my system and to read those logs. If I don't have enough visibility I would add those logs and then check it. I would also just re-run my test suite and just try to add some edge cases, look for race conditions and similar stuff because usually that's something that is missing. But again to make it reach for the main approach would be to make it reproducible.",
    duration_seconds: 53,
  });
  assert.equal(result.verdict, "borderline");
  assert.ok(result.score >= 0.6, `expected partial credit, got ${result.score}`);
  assert.ok(
    result.missed_points.some((point) => point.includes("request id")),
    `expected request-id miss, got ${result.missed_points.join(", ")}`,
  );
});

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

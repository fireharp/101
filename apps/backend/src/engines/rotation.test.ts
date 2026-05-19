import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

// Isolate this test's DB to a temp file before any module that touches
// the SQLite singleton is imported.
process.env.DATABASE_PATH = path.join(
  os.tmpdir(),
  `drill-rotation-test-${randomUUID()}.db`,
);
process.env.OPENAI_API_KEY = "";
process.env.USE_OFFLINE_GRADER = "1";

const { runMigrations } = await import("../db/migrations.js");
const { drills, attempts, skillState, sessions, users } = await import(
  "../db/repo.js"
);
const { selectNextDrill } = await import("./rotation.js");

runMigrations();

type SeedDrill = Parameters<typeof drills.upsert>[0];

const userId = "rotation-test-user";
users.ensure(userId);

function seedDrill(
  id: string,
  topic: string,
  subtopic: string,
  difficulty: 1 | 2 | 3 | 4 | 5,
  trap: string | null = null,
): void {
  const drill: SeedDrill = {
    id,
    topic,
    subtopic,
    difficulty,
    trap_type: trap,
    question_text: `Q ${id}`,
    expected_answer: { must_have: [], nice_to_have: [], red_flags: [] },
    rubric: { must_have: [], nice_to_have: [], red_flags: [] },
    canonical_short_answer: `A ${id}`,
    canonical_deep_answer: null,
    tags: [],
    is_active: true,
  };
  drills.upsert(drill);
}

seedDrill("db-a", "database", "indexes", 3, "equality_plus_order");
seedDrill("db-b", "database", "pagination", 2, "deep_offset");
seedDrill("db-c", "database", "covering", 4, "write_cost");
seedDrill("sd-a", "system_design", "rate_limiting", 3, "bucket_choice");
seedDrill("sd-b", "system_design", "caching", 3, "stale_read");
seedDrill("sd-c", "system_design", "queues", 2, "queue_mismatch");
seedDrill("cc-a", "concurrency", "locking", 3, "lock_choice");

test("selectNextDrill returns a drill from the pool", () => {
  const session = sessions.create(userId, "mixed");
  const drill = selectNextDrill({
    user_id: userId,
    session_id: session.id,
    mode: "mixed",
  });
  assert.ok(drill, "should return a drill");
  assert.ok(
    ["db-a", "db-b", "db-c", "sd-a", "sd-b", "sd-c", "cc-a"].includes(
      drill!.id,
    ),
  );
});

test("rotation does not repeat the exact same drill in a fresh session", () => {
  const session = sessions.create(userId, "mixed");
  const seen = new Set<string>();
  for (let i = 0; i < 5; i++) {
    const drill = selectNextDrill({
      user_id: userId,
      session_id: session.id,
      mode: "mixed",
    });
    assert.ok(drill, `iteration ${i} returned a drill`);
    // Record an attempt so the next iteration sees it as "recent".
    attempts.createPending({
      user_id: userId,
      session_id: session.id,
      drill_id: drill!.id,
    });
    seen.add(drill!.id);
  }
  // With 7 drills and 5 picks plus the recent-session penalty (-0.50 +
  // exact-repeat -0.30), we expect mostly unique picks.
  assert.ok(
    seen.size >= 4,
    `expected variety across 5 picks, got ${seen.size} unique`,
  );
});

test("db_indexes mode only returns database drills", () => {
  const session = sessions.create(userId, "db_indexes");
  for (let i = 0; i < 10; i++) {
    const drill = selectNextDrill({
      user_id: userId,
      session_id: session.id,
      mode: "db_indexes",
    });
    assert.ok(drill);
    assert.equal(
      drill!.topic,
      "database",
      `iter ${i} returned ${drill!.topic}/${drill!.id}`,
    );
  }
});

test("weak_topics mode surfaces high-weakness subtopics", () => {
  // Mark concurrency/locking as very weak; rotation should pick db/sd less
  // often in weak_topics mode.
  skillState.upsertAfterAttempt({
    user_id: userId,
    topic: "concurrency",
    subtopic: "locking",
    score: 0.0,
  });
  skillState.upsertAfterAttempt({
    user_id: userId,
    topic: "concurrency",
    subtopic: "locking",
    score: 0.1,
  });
  // Strong on everything else.
  skillState.upsertAfterAttempt({
    user_id: userId,
    topic: "database",
    subtopic: "indexes",
    score: 0.95,
  });
  skillState.upsertAfterAttempt({
    user_id: userId,
    topic: "system_design",
    subtopic: "caching",
    score: 0.95,
  });

  const session = sessions.create(userId, "weak_topics");
  let weakHits = 0;
  for (let i = 0; i < 30; i++) {
    const drill = selectNextDrill({
      user_id: userId,
      session_id: session.id,
      mode: "weak_topics",
    });
    assert.ok(drill);
    if (drill!.topic === "concurrency" && drill!.subtopic === "locking") {
      weakHits += 1;
    }
  }
  // Concurrency/locking should appear far more often than 1/7 chance baseline
  // (~4 hits). Asserting >= 8 across 30 picks keeps the test robust to
  // weighted-random noise.
  assert.ok(
    weakHits >= 8,
    `expected weak_topics to favor concurrency/locking, got ${weakHits}/30`,
  );
});

test("mock_interview mode prefers difficulty >= 3 and spreads topics", () => {
  // Seed a couple of difficulty-1 / -2 warm-ups alongside the harder ones.
  seedDrill("warm-1", "system_design", "warmup", 1);
  seedDrill("warm-2", "database", "warmup", 2);

  const session = sessions.create(userId, "mock_interview");
  const counts = new Map<string, number>();
  const difficulties: number[] = [];
  for (let i = 0; i < 12; i++) {
    const drill = selectNextDrill({
      user_id: userId,
      session_id: session.id,
      mode: "mock_interview",
    });
    assert.ok(drill);
    attempts.createPending({
      user_id: userId,
      session_id: session.id,
      drill_id: drill!.id,
    });
    counts.set(drill!.topic, (counts.get(drill!.topic) ?? 0) + 1);
    difficulties.push(drill!.difficulty);
  }
  // No more than ~half the picks should land in any single topic.
  const maxPerTopic = Math.max(...counts.values());
  assert.ok(
    maxPerTopic <= 7,
    `mock_interview should spread topics; max per topic was ${maxPerTopic}/12`,
  );
  const avgDifficulty =
    difficulties.reduce((s, d) => s + d, 0) / difficulties.length;
  assert.ok(
    avgDifficulty >= 2.8,
    `expected high difficulty avg; got ${avgDifficulty.toFixed(2)}`,
  );
});

test("rotation handles an empty pool gracefully", () => {
  const session = sessions.create("ghost-user", "mixed");
  // Deactivate all drills temporarily.
  const all = drills.list({ active: true });
  for (const d of all) {
    drills.upsert({ ...d, is_active: false });
  }
  const drill = selectNextDrill({
    user_id: "ghost-user",
    session_id: session.id,
    mode: "mixed",
  });
  assert.equal(drill, null);
  // Restore.
  for (const d of all) {
    drills.upsert({ ...d, is_active: true });
  }
});

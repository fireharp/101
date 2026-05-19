import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

// Isolate to a temp DB before importing anything that touches the SQLite
// singleton.
process.env.DATABASE_PATH = path.join(
  os.tmpdir(),
  `drill-seed-test-${randomUUID()}.db`,
);
process.env.OPENAI_API_KEY = "";

const { runMigrations } = await import("./migrations.js");
const { drills } = await import("./repo.js");
const { importDrillsFromYaml } = await import("./seed.js");

runMigrations();

const validDrill = {
  id: "seed_unit_001",
  topic: "seed_unit_test",
  subtopic: "happy_path",
  difficulty: 3,
  trap_type: null,
  question_text: "Minimal valid drill for the seed unit test.",
  expected_answer: { must_have: ["alpha"], nice_to_have: [], red_flags: [] },
  rubric: { must_have: ["alpha"], nice_to_have: [], red_flags: [] },
  canonical_short_answer: "Alpha is the canonical short answer here.",
  canonical_deep_answer: null,
  tags: ["unit-test"],
  is_active: true,
};

function toYaml(value: unknown): string {
  // Small inline serialiser — we don't want to pull in `yaml` just for tests
  // that mostly test parser-error paths. JSON is valid YAML.
  return JSON.stringify(value);
}

test("importDrillsFromYaml: parse failure on malformed YAML returns ok:false, no rows", () => {
  const result = importDrillsFromYaml(":\n  - not: [valid: yaml");
  assert.equal(result.ok, false);
  assert.equal(result.imported, 0);
  assert.equal(result.skipped.length, 1);
  assert.match(result.skipped[0].error, /YAML parse failed/i);
});

test("importDrillsFromYaml: empty document returns ok:false with explanatory skip", () => {
  const result = importDrillsFromYaml("");
  assert.equal(result.ok, false);
  assert.equal(result.imported, 0);
  assert.equal(result.skipped.length, 1);
  assert.match(result.skipped[0].error, /empty document/i);
});

test("importDrillsFromYaml: single object (not an array) is wrapped and imported", () => {
  const result = importDrillsFromYaml(toYaml(validDrill));
  assert.equal(result.ok, true);
  assert.equal(result.imported, 1);
  assert.equal(result.skipped.length, 0);

  const persisted = drills.get(validDrill.id);
  assert.ok(persisted, "single-object import should persist via upsert");
  assert.equal(persisted.canonical_short_answer, validDrill.canonical_short_answer);
});

test("importDrillsFromYaml: mixed valid + invalid items returns partial success with ok:false", () => {
  const valid2 = { ...validDrill, id: "seed_unit_002" };
  const invalidMissingRubric = {
    id: "seed_unit_invalid_001",
    topic: "seed_unit_test",
    subtopic: "missing_rubric",
    difficulty: 3,
    question_text: "Drill missing required rubric field.",
    canonical_short_answer: "doesn't matter",
    // rubric: omitted — schema requires it
  };

  const result = importDrillsFromYaml(toYaml([valid2, invalidMissingRubric]));
  assert.equal(result.ok, false, "any skip should flip ok to false");
  assert.equal(result.imported, 1);
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0].id, "seed_unit_invalid_001");

  assert.ok(drills.get("seed_unit_002"), "valid drill should still upsert");
  assert.equal(
    drills.get("seed_unit_invalid_001"),
    null,
    "invalid drill must not be persisted",
  );
});

test("importDrillsFromYaml: is_active defaults to true when omitted", () => {
  const noFlag = { ...validDrill, id: "seed_unit_003" };
  // biome-ignore lint: deliberately exercising the optional-field branch
  delete (noFlag as { is_active?: boolean }).is_active;
  const result = importDrillsFromYaml(toYaml([noFlag]));
  assert.equal(result.ok, true);
  assert.equal(result.imported, 1);
  const persisted = drills.get("seed_unit_003");
  assert.ok(persisted);
  assert.equal(persisted.is_active, true);
});

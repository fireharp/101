import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { draftDrillsToYaml, documentsToDraftDrills } from "./drills.js";
import { globToRegExp, selectPaths } from "./glob.js";
import {
  hashText,
  inferDifficulty,
  inferTopics,
  splitMarkdownSections,
} from "./markdown.js";
import { loadResourceManifest, selectResources } from "./manifest.js";
import type { ResourceDocument } from "./types.js";

test("glob selection supports exact, star, and recursive patterns", () => {
  const paths = [
    "README.md",
    "README-zh-Hans.md",
    "solutions/system_design/twitter/README.md",
    "solutions/system_design/twitter/README-zh-Hans.md",
    "data/guides/cache.md",
  ];
  assert.equal(globToRegExp("solutions/system_design/**/README.md").test(paths[2]!), true);
  assert.deepEqual(
    selectPaths(
      paths,
      ["README.md", "solutions/system_design/**/README.md", "data/guides/*.md"],
      ["README-*.md", "solutions/system_design/**/README-*.md"],
    ),
    ["README.md", "data/guides/cache.md", "solutions/system_design/twitter/README.md"],
  );
});

test("markdown splitting cleans sections and infers metadata", () => {
  const sections = splitMarkdownSections(
    `# Caching\n\nCaching improves latency and throughput in distributed systems.\n\n## Cache Aside\n\nUse cache aside with Redis. Discuss invalidation, consistency, failure modes, and tradeoffs. This section has enough content to become a useful interview drill because it names mechanisms and constraints.\n`,
    "Fallback",
  );
  assert.equal(sections.length, 1);
  assert.equal(sections[0]?.title, "Cache Aside");
  assert.deepEqual(inferTopics("cache aside redis"), ["caching"]);
  assert.ok(inferDifficulty(sections[0]!.text, sections[0]!.title) >= 3);
  assert.equal(hashText("same"), hashText("same"));
});

test("manifest loading and fixture selection validate resource skills", () => {
  const manifest = loadResourceManifest();
  const fixtures = selectResources(manifest, "fixtures");
  assert.equal(fixtures.length, 3);
  assert.ok(fixtures.every((resource) => resource.tags.includes("fixture")));
});

test("documents become inactive seed-compatible draft drills", () => {
  const doc: ResourceDocument = {
    source_id: "resource:path:hash",
    source_slug: "sample-resource",
    source_title: "Sample Resource",
    source_url: "https://example.com/source",
    repo: "owner/repo",
    branch: "main",
    path: "README.md",
    title: "Consistent Hashing",
    section: "## Consistent Hashing",
    text: "Consistent hashing spreads keys across nodes while limiting remaps when nodes join or leave. A strong answer should cover the ring, virtual nodes, hot spots, replication, and tradeoffs.",
    topics: ["distributed"],
    difficulty_hint: 4,
    extract_method: "github_raw",
    hash: "abc",
    extracted_at: new Date().toISOString(),
  };
  const drills = documentsToDraftDrills([doc]);
  assert.equal(drills.length, 1);
  assert.equal(drills[0]?.is_active, false);
  assert.match(drills[0]?.id ?? "", /^ext_sample_resource_/);
  const yaml = draftDrillsToYaml(drills);
  assert.match(yaml, /is_active: false/);
});

test("inactive draft YAML imports through existing seed schema", async () => {
  process.env.DATABASE_PATH = path.join(
    os.tmpdir(),
    `resource-extraction-${randomUUID()}.db`,
  );
  process.env.OPENAI_API_KEY = "";
  const { runMigrations } = await import("../db/migrations.js");
  const { importDrillsFromYaml } = await import("../db/seed.js");
  const { drills } = await import("../db/repo.js");
  runMigrations();
  const result = importDrillsFromYaml(`
- id: ext_test_inactive
  topic: system_design
  subtopic: extraction
  difficulty: 3
  trap_type: source_summary
  question_text: Explain extraction.
  expected_answer:
    must_have: [core mechanism]
    nice_to_have: []
    red_flags: []
  rubric:
    must_have: [core mechanism]
    nice_to_have: []
    red_flags: []
  canonical_short_answer: Extraction turns resource text into drills.
  canonical_deep_answer: null
  tags: [extracted]
  is_active: false
`);
  assert.equal(result.ok, true);
  const draft = drills.get("ext_test_inactive");
  assert.equal(draft?.is_active, false);
});

import type { DrillItem } from "../types.js";

export const Drill = {
  indexQuestion(): DrillItem {
    return {
      id: "db_index_test",
      topic: "database",
      subtopic: "composite_indexes",
      difficulty: 3,
      trap_type: "equality_plus_order_by",
      question_text:
        "Filter active products in one category sorted cheapest first. Index?",
      expected_answer: {
        must_have: [
          "composite B-tree index",
          "category_id before price",
          "verify with EXPLAIN ANALYZE",
        ],
        nice_to_have: ["partial index on status active", "covering index"],
        red_flags: ["index every column", "hash index for ordering"],
      },
      rubric: {
        must_have: [
          "composite B-tree",
          "category_id before price",
          "verify with EXPLAIN ANALYZE",
        ],
        nice_to_have: ["partial index on status active", "covering index"],
        red_flags: ["index every column", "hash index for ordering"],
      },
      canonical_short_answer:
        "Composite B-tree on (category_id, price). Verify with EXPLAIN ANALYZE.",
      canonical_deep_answer: null,
      tags: ["postgres", "indexing"],
      is_active: true,
      created_at: new Date().toISOString(),
    };
  },

  rapidSecurityQuestion(): DrillItem {
    return {
      id: "rapid_security_test",
      topic: "security",
      subtopic: "sql_injection",
      difficulty: 2,
      trap_type: "unsafe_string_concat",
      question_text:
        "In 30 seconds, show what SQL injection is and how you prevent it.",
      expected_answer: {
        must_have: [
          "user input changes query structure",
          "parameterized queries",
          "no string interpolation",
        ],
        nice_to_have: ["allowlist dynamic identifiers"],
        red_flags: ["escaping alone is enough"],
      },
      rubric: {
        must_have: [
          "user input changes query structure",
          "parameterized queries",
          "no string interpolation",
        ],
        nice_to_have: ["allowlist dynamic identifiers"],
        red_flags: ["escaping alone is enough"],
      },
      canonical_short_answer:
        "SQL injection is user input changing query structure. Use parameterized queries, avoid string interpolation, and allowlist dynamic identifiers when needed.",
      canonical_deep_answer: null,
      tags: ["rapid_fundamentals", "betterstack", "security"],
      is_active: true,
      created_at: new Date().toISOString(),
    };
  },

  apiVersioningQuestion(): DrillItem {
    return {
      id: "api_versioning_test",
      topic: "api_design",
      subtopic: "versioning",
      difficulty: 2,
      trap_type: "rename_semantics",
      question_text:
        "You need to rename a field in a public REST API and change its semantics. Mobile clients update slowly. How do you roll this out?",
      expected_answer: {
        must_have: [
          "additive change first",
          "dual emit old and new fields",
          "version bump only when truly breaking",
          "deprecation timeline communicated",
        ],
        nice_to_have: ["observability on deprecated usage", "per-client gating"],
        red_flags: ["breaking change with no version", "reuse field for new meaning"],
      },
      rubric: {
        must_have: [
          "additive then deprecated then removed",
          "never silently change semantics",
          "communicate timeline",
        ],
        nice_to_have: ["observability on deprecated usage", "per-client gating"],
        red_flags: ["breaking change with no version", "reuse field for new meaning"],
      },
      canonical_short_answer:
        "Treat it as additive first. Emit both the old and new fields, document the new one, log usage of the old one, and only remove it when telemetry shows old clients are gone. If the semantics truly change, version the endpoint and let clients opt in.",
      canonical_deep_answer: null,
      tags: ["api_design", "versioning"],
      is_active: true,
      created_at: new Date().toISOString(),
    };
  },
};

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
};

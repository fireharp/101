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
      examples: [],
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
      examples: [],
      tags: ["rapid_fundamentals", "betterstack", "security"],
      is_active: true,
      created_at: new Date().toISOString(),
    };
  },

  rapidRubySqlInjectionQuestion(): DrillItem {
    return {
      id: "betterstack_peter_sql_injection_ruby_001",
      topic: "security",
      subtopic: "sql_injection",
      difficulty: 2,
      trap_type: "unsafe_string_concat",
      question_text:
        "You review Ruby code: email = params[:email]; User.find_by_sql(\"SELECT * FROM users WHERE email = '#{email}'\"). What is wrong, how is it exploited, and what is the fix?",
      expected_answer: {
        must_have: [
          "SQL injection",
          "use parameterized queries or ORM binding",
          "user input becomes SQL code not data",
        ],
        nice_to_have: [
          "avoid SQL string interpolation",
          "allowlist dynamic identifiers and keep DB privileges narrow",
        ],
        red_flags: ["escaping quotes or sanitizing alone is enough"],
      },
      rubric: {
        must_have: [
          "SQL injection",
          "use parameterized queries or ORM binding",
          "user input becomes SQL code not data",
        ],
        nice_to_have: [
          "avoid SQL string interpolation",
          "allowlist dynamic identifiers and keep DB privileges narrow",
        ],
        red_flags: ["escaping quotes or sanitizing alone is enough"],
      },
      canonical_short_answer:
        "It is SQL injection: attacker-controlled email becomes part of the SQL structure. Use the ORM or bound parameters so input stays a value, never interpolate values into SQL strings; allowlist dynamic identifiers if any.",
      canonical_deep_answer: null,
      examples: [
        {
          use_case: "Login lookup by email",
          why_it_fits:
            "The attacker controls the email value and can change the WHERE clause if it is interpolated.",
          gotcha:
            "Escaping quotes is brittle; ORM binding or parameters keep input as data.",
        },
      ],
      tags: ["rapid_fundamentals", "betterstack", "peterheinz", "security", "ruby", "sql"],
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
      examples: [],
      tags: ["api_design", "versioning"],
      is_active: true,
      created_at: new Date().toISOString(),
    };
  },

  keepAlivePoolQuestion(): DrillItem {
    return {
      id: "net_keepalive_pool_001",
      topic: "networking",
      subtopic: "connection_pools",
      difficulty: 3,
      trap_type: "pool_exhaustion",
      question_text:
        "Your service makes 5000 RPS of outbound HTTPS calls to a downstream API. Every call opens a fresh TCP+TLS connection and tail latency is awful. What do you change?",
      expected_answer: {
        must_have: [
          "reuse connections via HTTP keep-alive",
          "sized connection pool",
          "configure idle timeout",
          "TLS handshake cost dominates fresh connects",
        ],
        nice_to_have: ["HTTP/2 multiplexing", "circuit breaker on the downstream"],
        red_flags: ["increase request timeout", "disable TLS"],
      },
      rubric: {
        must_have: [
          "keep-alive / pooling",
          "bound pool size",
          "TLS handshake cost",
        ],
        nice_to_have: ["HTTP/2 single connection", "DNS caching"],
        red_flags: ["new conn per request is fine", "infinite pool"],
      },
      canonical_short_answer:
        "Reuse TCP+TLS connections with HTTP keep-alive and a properly sized pool. Fresh handshakes dominate p99 — eliminating them is the win. Bound the pool to avoid head-of-line blocking when the downstream slows. Use HTTP/2 for multiplexing if the downstream supports it.",
      canonical_deep_answer: null,
      examples: [],
      tags: ["http", "latency", "scaling"],
      is_active: true,
      created_at: new Date().toISOString(),
    };
  },

  jwtRevocationQuestion(): DrillItem {
    return {
      id: "sec_jwt_tradeoffs_002",
      topic: "security",
      subtopic: "tokens",
      difficulty: 3,
      trap_type: "stateless_revocation",
      question_text:
        "Your team wants stateless JWT auth for the API. What's the catch and how do you handle revocation?",
      expected_answer: {
        must_have: [
          "JWTs are valid until expiry by design",
          "no built-in revocation",
          "short lifetime + refresh tokens",
          "or maintain a revocation list / version field",
        ],
        nice_to_have: ["logout requires server-side state for immediate effect"],
        red_flags: ["long-lived JWTs are fine", "logout by deleting local token only"],
      },
      rubric: {
        must_have: [
          "revocation problem named",
          "short TTL + refresh",
          "or denylist / version",
        ],
        nice_to_have: ["server-side state tradeoff"],
        red_flags: ["long-lived JWTs are fine", "30-day JWTs by default"],
      },
      canonical_short_answer:
        "Stateless JWTs are valid until they expire. Use short lifetimes plus refresh tokens, or keep a small revocation list / per-user version field that the server checks.",
      canonical_deep_answer: null,
      examples: [],
      tags: ["auth", "jwt"],
      is_active: true,
      created_at: new Date().toISOString(),
    };
  },

  rapidDebuggingQuestion(): DrillItem {
    return {
      id: "rapid_debugging_test",
      topic: "observability",
      subtopic: "debugging",
      difficulty: 3,
      trap_type: "random_guessing",
      question_text:
        "A customer reports a 500 on one endpoint, but you cannot reproduce it locally. What is your debugging path?",
      expected_answer: {
        must_have: [
          "find request id trace or specific failing request",
          "inspect logs and add missing instrumentation",
          "make issue reproducible and add regression or edge case test",
        ],
        nice_to_have: ["mention race conditions edge cases or dependency context"],
        red_flags: ["restart the service and hope"],
      },
      rubric: {
        must_have: [
          "find request id trace or specific failing request",
          "inspect logs and add missing instrumentation",
          "make issue reproducible and add regression or edge case test",
        ],
        nice_to_have: ["mention race conditions edge cases or dependency context"],
        red_flags: ["restart the service and hope"],
      },
      canonical_short_answer:
        "Start from a request id, trace, or exact failing request if possible. Inspect logs with inputs, user/tenant, version, and dependency context; add missing instrumentation if the trail is thin. Reproduce with sanitized real conditions, fix the cause, and add a regression test.",
      canonical_deep_answer: null,
      examples: [],
      tags: ["rapid_fundamentals", "betterstack", "peterheinz", "observability"],
      is_active: true,
      created_at: new Date().toISOString(),
    };
  },
};

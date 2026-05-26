import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

process.env.DATABASE_PATH = path.join(
  os.tmpdir(),
  `drill-shadow-grading-test-${randomUUID()}.db`,
);
process.env.OPENROUTER_API_KEY = "test-openrouter-key";
process.env.OPENROUTER_MODEL_TTL_MS = "600000";
process.env.OPENROUTER_COOLDOWN_MS = "600000";
process.env.OPENAI_API_KEY = "";
process.env.USE_OFFLINE_GRADER = "1";

const { runMigrations } = await import("../db/migrations.js");
const { attempts, drills, gradingEvaluations } = await import("../db/repo.js");
const { runGraderBenchmark } = await import("./grader-benchmark.js");
const { evaluateAttemptWithOpenRouter } = await import("./shadow-grading.js");
const {
  FREE_PINNED_OPENROUTER_MODELS,
  resetOpenRouterCaches,
} = await import("../services/openrouter.js");

runMigrations();

test.afterEach(() => resetOpenRouterCaches());

function seedAttempt() {
  const drill = {
    id: `shadow_sql_${randomUUID()}`,
    topic: "security",
    subtopic: "sql_injection",
    difficulty: 2 as const,
    trap_type: "unsafe_string_concat",
    question_text: "Explain SQL injection and the fix.",
    expected_answer: {
      must_have: ["SQL injection", "parameterized queries"],
      nice_to_have: ["avoid string interpolation"],
      red_flags: ["escaping alone is enough"],
    },
    rubric: {
      must_have: ["SQL injection", "parameterized queries"],
      nice_to_have: ["avoid string interpolation"],
      red_flags: ["escaping alone is enough"],
    },
    canonical_short_answer:
      "SQL injection lets input change query structure; use bound parameters.",
    canonical_deep_answer: null,
    tags: ["rapid_fundamentals"],
    is_active: true,
  };
  drills.upsert(drill);
  const attempt = attempts.createPending({
    user_id: "shadow-user",
    session_id: `shadow-session-${randomUUID()}`,
    drill_id: drill.id,
  });
  attempts.updateTranscript(
    attempt.id,
    "It is SQL injection; use parameterized queries.",
    30,
  );
  attempts.updateGrade(attempt.id, {
    score: 0.2,
    verdict: "fail",
    missed_points: ["avoid string interpolation"],
    ideal_answer: drill.canonical_short_answer,
    created_cards: [],
  });
  return { drill, attempt: attempts.get(attempt.id)! };
}

test("OpenRouter shadow evaluation skips unavailable models, caches successes, and leaves live grade unchanged", async () => {
  const { drill, attempt } = seedAttempt();
  let chatCalls = 0;
  const fetchImpl = async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/models")) {
      return jsonResponse({
        data: FREE_PINNED_OPENROUTER_MODELS.slice(0, 2).map((id) => ({
          id,
          architecture: { output_modalities: ["text"] },
          pricing: { prompt: "0", completion: "0", request: "0", internal_reasoning: "0" },
          supported_parameters: ["response_format"],
        })),
      });
    }
    chatCalls += 1;
    if (chatCalls === 1) {
      return jsonResponse({ error: "rate limited" }, 429);
    }
    return jsonResponse({
      model: FREE_PINNED_OPENROUTER_MODELS[1],
      choices: [
        {
          message: {
            content: JSON.stringify({
              score: 0.82,
              verdict: "pass",
              covered_points: ["SQL injection", "parameterized queries"],
              missed_points: [],
              ideal_short_answer: "Use bound parameters.",
            }),
          },
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
    });
  };

  const first = await evaluateAttemptWithOpenRouter({
    attempt,
    drill,
    fetchImpl: fetchImpl as typeof fetch,
  });
  assert.equal(first.evaluations.length, 2);
  assert.equal(first.evaluations.filter((e) => e.error).length, 1);
  assert.equal(first.evaluations.filter((e) => e.score !== null).length, 1);
  assert.equal(attempts.get(attempt.id)?.score, 0.2);

  const second = await evaluateAttemptWithOpenRouter({
    attempt,
    drill,
    fetchImpl: fetchImpl as typeof fetch,
  });
  assert.equal(chatCalls, 2, "cached success should avoid another chat call");
  assert.equal(second.evaluations.length, 1);
  assert.equal(second.evaluations[0]?.cached, true);
  assert.equal(gradingEvaluations.listForAttempt(attempt.id).length, 2);
});

test("OpenRouter malformed model JSON records an error row", async () => {
  const { drill, attempt } = seedAttempt();
  const fetchImpl = async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/models")) {
      return jsonResponse({
        data: [
          {
            id: FREE_PINNED_OPENROUTER_MODELS[0],
            architecture: { output_modalities: ["text"] },
            pricing: { prompt: "0", completion: "0", request: "0", internal_reasoning: "0" },
            supported_parameters: ["response_format"],
          },
        ],
      });
    }
    return jsonResponse({
      model: FREE_PINNED_OPENROUTER_MODELS[0],
      choices: [{ message: { content: "not json" } }],
    });
  };

  const result = await evaluateAttemptWithOpenRouter({
    attempt,
    drill,
    fetchImpl: fetchImpl as typeof fetch,
    force: true,
  });
  assert.equal(result.evaluations.length, 1);
  assert.ok(result.evaluations[0]?.error);
  assert.equal(gradingEvaluations.listForAttempt(attempt.id)[0]?.score, null);
});

test("historical grader benchmark creates shadow evaluation rows", async () => {
  seedAttempt();
  const fetchImpl = async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/models")) {
      return jsonResponse({
        data: [
          {
            id: FREE_PINNED_OPENROUTER_MODELS[0],
            architecture: { output_modalities: ["text"] },
            pricing: { prompt: "0", completion: "0", request: "0", internal_reasoning: "0" },
            supported_parameters: ["response_format"],
          },
        ],
      });
    }
    return jsonResponse({
      model: FREE_PINNED_OPENROUTER_MODELS[0],
      choices: [
        {
          message: {
            content: JSON.stringify({
              score: 0.7,
              verdict: "borderline",
              covered_points: ["SQL injection"],
              missed_points: ["avoid string interpolation"],
              ideal_short_answer: "Use bound parameters.",
            }),
          },
        },
      ],
    });
  };

  const result = await runGraderBenchmark({
    source: "historical",
    modelsPolicy: "free-pinned",
    limit: 1,
    userId: "shadow-user",
    fetchImpl: fetchImpl as typeof fetch,
  });
  assert.equal(result.attempts, 1);
  assert.equal(result.evaluations, 1);
  assert.equal(result.errors, 0);
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

import { createHash } from "node:crypto";
import type {
  DrillAttempt,
  DrillItem,
  GradingEvaluation,
  GradingResult,
} from "../types.js";
import { gradingEvaluations } from "../db/repo.js";
import {
  OpenRouterError,
  chatCompletionJson,
  fetchOpenRouterModels,
  isOpenRouterModelOnCooldown,
  markOpenRouterModelUnavailable,
  selectOpenRouterModels,
  type OpenRouterModelPolicy,
} from "../services/openrouter.js";

const SHADOW_GRADER_PROMPT_VERSION = "openrouter-shadow-grader-v1";

export interface ShadowEvaluationRun {
  evaluations: GradingEvaluation[];
  prompt_hash: string;
  models: string[];
}

type FetchImpl = typeof fetch;

export async function evaluateAttemptWithOpenRouter(opts: {
  attempt: DrillAttempt;
  drill: DrillItem;
  modelsPolicy?: OpenRouterModelPolicy;
  force?: boolean;
  fetchImpl?: FetchImpl;
}): Promise<ShadowEvaluationRun> {
  if (!opts.attempt.transcript) {
    throw new Error("transcript missing — grade or submit the attempt first");
  }

  const models = selectOpenRouterModels(
    await fetchOpenRouterModels(opts.fetchImpl),
    opts.modelsPolicy ?? "free-pinned",
  ).filter((model) => !isOpenRouterModelOnCooldown(model));
  const promptHash = promptHashFor(opts.attempt, opts.drill);
  const evaluations: GradingEvaluation[] = [];

  for (const model of models) {
    const cached = opts.force
      ? null
      : gradingEvaluations.findCached({
          attempt_id: opts.attempt.id,
          provider: "openrouter",
          model,
          prompt_hash: promptHash,
        });
    if (cached) {
      evaluations.push({ ...cached, cached: true });
      continue;
    }

    const started = Date.now();
    try {
      const response = await chatCompletionJson({
        model,
        messages: buildMessages(opts.attempt, opts.drill),
        fetchImpl: opts.fetchImpl,
      });
      const parsed = parseEvaluationJson(response.content);
      evaluations.push(
        gradingEvaluations.upsert({
          user_id: opts.attempt.user_id,
          session_id: opts.attempt.session_id,
          attempt_id: opts.attempt.id,
          drill_id: opts.drill.id,
          provider: "openrouter",
          model,
          score: parsed.score,
          verdict: parsed.verdict,
          covered_points: parsed.covered_points,
          missed_points: parsed.missed_points,
          ideal_answer: parsed.ideal_short_answer,
          raw_json: response.raw,
          latency_ms: response.latency_ms,
          error: null,
          estimated_cost_usd: 0,
          prompt_hash: promptHash,
        }),
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (err instanceof OpenRouterError && err.retryable) {
        markOpenRouterModelUnavailable(model);
      }
      evaluations.push(
        gradingEvaluations.upsert({
          user_id: opts.attempt.user_id,
          session_id: opts.attempt.session_id,
          attempt_id: opts.attempt.id,
          drill_id: opts.drill.id,
          provider: "openrouter",
          model,
          score: null,
          verdict: null,
          covered_points: null,
          missed_points: null,
          ideal_answer: null,
          raw_json:
            err instanceof OpenRouterError &&
            err.body &&
            typeof err.body === "object"
              ? (err.body as Record<string, unknown>)
              : { error: message },
          latency_ms: Date.now() - started,
          error: message,
          estimated_cost_usd: 0,
          prompt_hash: promptHash,
        }),
      );
    }
  }

  return { evaluations, prompt_hash: promptHash, models };
}

export function promptHashFor(
  attempt: Pick<DrillAttempt, "transcript" | "duration_seconds">,
  drill: DrillItem,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        version: SHADOW_GRADER_PROMPT_VERSION,
        question_text: drill.question_text,
        rubric: drill.rubric,
        expected_answer: drill.expected_answer,
        canonical_short_answer: drill.canonical_short_answer,
        transcript: attempt.transcript,
        duration_seconds: attempt.duration_seconds ?? 0,
      }),
    )
    .digest("hex");
}

function buildMessages(
  attempt: DrillAttempt,
  drill: DrillItem,
): { role: "system" | "user"; content: string }[] {
  return [
    {
      role: "system",
      content:
        "You are an independent shadow grader for short technical interview drill answers. Grade against the explicit rubric, but give semantic credit for equivalent wording. Return only valid JSON.",
    },
    {
      role: "user",
      content: JSON.stringify({
        task: "Grade this attempt. Do not generate flashcards.",
        scoring: {
          score: "number from 0 to 1",
          verdict: "pass for >=0.8, borderline for >=0.6, fail below 0.6",
          covered_points: "rubric points clearly covered",
          missed_points: "rubric points still missing or too vague",
          ideal_short_answer: "concise corrected answer",
          breakdown:
            "object with must_have_coverage, answer_clarity, tradeoff_coverage, speed_score, red_flag_penalty as 0..1 numbers",
        },
        drill: {
          id: drill.id,
          topic: drill.topic,
          subtopic: drill.subtopic,
          question_text: drill.question_text,
          rubric: drill.rubric,
          canonical_short_answer: drill.canonical_short_answer,
          tags: drill.tags,
        },
        attempt: {
          transcript: attempt.transcript,
          duration_seconds: attempt.duration_seconds ?? 0,
          primary_score: attempt.score,
          primary_verdict: attempt.verdict,
        },
      }),
    },
  ];
}

function parseEvaluationJson(content: string): {
  score: GradingResult["score"];
  verdict: GradingResult["verdict"];
  covered_points: string[];
  missed_points: string[];
  ideal_short_answer: string;
} {
  const parsed = JSON.parse(stripJsonFence(content)) as Partial<GradingResult>;
  const score = clamp01(Number(parsed.score ?? 0));
  const verdict =
    parsed.verdict === "pass" ||
    parsed.verdict === "borderline" ||
    parsed.verdict === "fail"
      ? parsed.verdict
      : score >= 0.8
        ? "pass"
        : score >= 0.6
          ? "borderline"
          : "fail";
  return {
    score: round3(score),
    verdict,
    covered_points: stringArray(parsed.covered_points),
    missed_points: stringArray(parsed.missed_points),
    ideal_short_answer:
      typeof parsed.ideal_short_answer === "string"
        ? parsed.ideal_short_answer
        : "",
  };
}

function stripJsonFence(content: string): string {
  const trimmed = content.trim();
  const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  return match ? match[1]!.trim() : trimmed;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

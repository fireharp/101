import type { DrillItem, GeneratedCard, GradingResult, Rubric } from "../types.js";
import { config } from "../config.js";
import { hasOpenAI, openai } from "../services/llm.js";

/**
 * Grading per LOCAL.md §10:
 *   score = 0.65 * mustHaveCoverage
 *         + 0.20 * answerClarity
 *         + 0.10 * tradeoffCoverage
 *         + 0.05 * speedScore
 *         - redFlagPenalty
 * Verdict thresholds: >=0.80 pass, 0.60–0.79 borderline, <0.60 fail.
 *
 * Two paths:
 *   1. LLM grader (default when OPENAI_API_KEY is present).
 *   2. Deterministic keyword/heuristic grader (offline tests, missing key).
 */

export interface GradeInput {
  drill: DrillItem;
  transcript: string;
  duration_seconds: number;
}

export async function gradeAttempt(input: GradeInput): Promise<GradingResult> {
  if (config.useOfflineGrader || !hasOpenAI()) {
    return offlineGrade(input);
  }
  try {
    return await llmGrade(input);
  } catch (err) {
    // Don't fail the whole flow if the model call breaks — fall back.
    console.warn("LLM grading failed, falling back to offline grader:", err);
    return offlineGrade(input);
  }
}

function verdictFromScore(score: number): GradingResult["verdict"] {
  if (score >= 0.8) return "pass";
  if (score >= 0.6) return "borderline";
  return "fail";
}

function speedScore(durationSeconds: number): number {
  // Reward concise default answers (30–90s) per LOCAL.md §11.
  if (durationSeconds <= 0) return 0.3;
  if (durationSeconds < 20) return 0.6; // too short
  if (durationSeconds <= 60) return 1;
  if (durationSeconds <= 90) return 0.8;
  if (durationSeconds <= 120) return 0.5;
  return 0.2;
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ");
}

function keywordsOf(phrase: string): string[] {
  return normalize(phrase)
    .split(" ")
    .filter((w) => w.length > 3);
}

function coverage(transcript: string, items: string[]): {
  hit: string[];
  miss: string[];
} {
  const t = normalize(transcript);
  const hit: string[] = [];
  const miss: string[] = [];
  for (const item of items) {
    const kws = keywordsOf(item);
    if (kws.length === 0) {
      miss.push(item);
      continue;
    }
    const matched = kws.filter((kw) => t.includes(kw)).length;
    // Consider "covered" if at least half of meaningful keywords appear.
    if (matched / kws.length >= 0.5) hit.push(item);
    else miss.push(item);
  }
  return { hit, miss };
}

function answerClarity(transcript: string): number {
  const trimmed = transcript.trim();
  if (!trimmed) return 0;
  const words = trimmed.split(/\s+/).length;
  // Penalize extremely short or extremely long answers.
  if (words < 15) return 0.35;
  if (words < 30) return 0.6;
  if (words <= 250) return 0.9;
  return 0.55;
}

function offlineGrade(input: GradeInput): GradingResult {
  const { drill, transcript, duration_seconds } = input;
  const rubric: Rubric = drill.rubric;

  const must = coverage(transcript, rubric.must_have);
  const nice = coverage(transcript, rubric.nice_to_have);
  const flags = coverage(transcript, rubric.red_flags);

  const mustHaveCoverage =
    rubric.must_have.length === 0
      ? 0.5
      : must.hit.length / rubric.must_have.length;
  const tradeoffCoverage =
    rubric.nice_to_have.length === 0
      ? 0
      : nice.hit.length / rubric.nice_to_have.length;
  const clarity = answerClarity(transcript);
  const speed = speedScore(duration_seconds);
  const redFlagPenalty = flags.hit.length * 0.15;

  const raw =
    0.65 * mustHaveCoverage +
    0.2 * clarity +
    0.1 * tradeoffCoverage +
    0.05 * speed -
    redFlagPenalty;
  const score = Math.max(0, Math.min(1, raw));

  const cards: GeneratedCard[] = must.miss.slice(0, 2).map((point) => ({
    drill_id: drill.id,
    topic: drill.topic,
    subtopic: drill.subtopic,
    front: `For "${drill.question_text.split("\n")[0]}", what should you say about: ${point}?`,
    back: drill.canonical_short_answer,
  }));

  return {
    score: round3(score),
    verdict: verdictFromScore(score),
    missed_points: must.miss,
    ideal_short_answer: drill.canonical_short_answer,
    follow_up_drills: [],
    cards,
    breakdown: {
      must_have_coverage: round3(mustHaveCoverage),
      answer_clarity: round3(clarity),
      tradeoff_coverage: round3(tradeoffCoverage),
      speed_score: round3(speed),
      red_flag_penalty: round3(redFlagPenalty),
    },
  };
}

async function llmGrade(input: GradeInput): Promise<GradingResult> {
  const { drill, transcript, duration_seconds } = input;
  const client = openai();

  const system = `You are a strict staff-level interview drill grader.
You receive a drill rubric, the user's spoken-answer transcript, and the answer duration.
You grade against the rubric. Return JSON only, matching the requested schema.
Score components are floats in [0, 1] unless stated otherwise.
Verdict thresholds: score >= 0.80 → pass; 0.60–0.79 → borderline; < 0.60 → fail.
Be honest, not generous. Reward concise default answers; penalize rambling.`;

  const userMsg = {
    drill: {
      id: drill.id,
      topic: drill.topic,
      subtopic: drill.subtopic,
      question: drill.question_text,
      rubric: drill.rubric,
      canonical_short_answer: drill.canonical_short_answer,
    },
    transcript,
    duration_seconds,
    formula:
      "score = 0.65*must_have_coverage + 0.20*answer_clarity + 0.10*tradeoff_coverage + 0.05*speed_score - red_flag_penalty",
    response_shape: {
      score: "float 0..1 final score",
      verdict: "pass|borderline|fail",
      missed_points: "string[] of rubric items the user did not cover or got wrong",
      ideal_short_answer: "string, <=4 sentences",
      follow_up_drills: "string[] of short slugs for related concepts",
      cards: '[ { "front": string, "back": string } ]',
      breakdown: {
        must_have_coverage: "0..1",
        answer_clarity: "0..1",
        tradeoff_coverage: "0..1",
        speed_score: "0..1",
        red_flag_penalty: "0..1",
      },
    },
  };

  const resp = await client.chat.completions.create({
    model: config.gradingModel,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: system },
      { role: "user", content: JSON.stringify(userMsg) },
    ],
    temperature: 0.2,
  });

  const content = resp.choices[0]?.message?.content;
  if (!content) throw new Error("Empty LLM response");
  const parsed = JSON.parse(content) as Partial<GradingResult>;

  const score = clamp01(Number(parsed.score ?? 0));
  const cards = (parsed.cards ?? []).map((c) => ({
    ...c,
    drill_id: drill.id,
    topic: drill.topic,
    subtopic: drill.subtopic,
  }));

  return {
    score: round3(score),
    verdict: parsed.verdict ?? verdictFromScore(score),
    missed_points: parsed.missed_points ?? [],
    ideal_short_answer:
      parsed.ideal_short_answer ?? drill.canonical_short_answer,
    follow_up_drills: parsed.follow_up_drills ?? [],
    cards,
    breakdown: {
      must_have_coverage: round3(
        clamp01(Number(parsed.breakdown?.must_have_coverage ?? 0)),
      ),
      answer_clarity: round3(
        clamp01(Number(parsed.breakdown?.answer_clarity ?? 0)),
      ),
      tradeoff_coverage: round3(
        clamp01(Number(parsed.breakdown?.tradeoff_coverage ?? 0)),
      ),
      speed_score: round3(
        clamp01(Number(parsed.breakdown?.speed_score ?? 0)),
      ),
      red_flag_penalty: round3(
        clamp01(Number(parsed.breakdown?.red_flag_penalty ?? 0)),
      ),
    },
  };
}

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

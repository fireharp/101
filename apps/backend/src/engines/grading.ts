import type {
  DrillItem,
  GeneratedCard,
  GradingResult,
  Rubric,
  TokenUsage,
} from "../types.js";
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
  if (isRapidFundamentals(input.drill)) {
    if (config.useOfflineGrader || !hasOpenAI()) {
      return rapidOfflineGrade(input);
    }
    try {
      return await rapidLlmGrade(input);
    } catch (err) {
      console.warn("Rapid LLM grading failed, falling back to offline grader:", err);
      return rapidOfflineGrade(input);
    }
  }

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

const STOPWORDS = new Set([
  "also",
  "first",
  "from",
  "into",
  "only",
  "then",
  "this",
  "that",
  "when",
  "while",
  "with",
  "change",
  "changes",
  "field",
  "fields",
  "index",
  "indexes",
  "column",
  "columns",
  "query",
  "queries",
]);

const TOKEN_ALIASES: Record<string, string> = {
  add: "additive",
  added: "additive",
  adding: "additive",
  additive: "additive",
  allowlist: "allowlist",
  allowlisted: "allowlist",
  allowlisting: "allowlist",
  announce: "communicate",
  announced: "communicate",
  communicates: "communicate",
  communicated: "communicate",
  communication: "communicate",
  deprecate: "deprecated",
  deprecated: "deprecated",
  deprecating: "deprecated",
  deprecation: "deprecated",
  docs: "document",
  documented: "document",
  documentation: "document",
  emit: "emit",
  emits: "emit",
  emitted: "emit",
  existing: "old",
  gone: "removed",
  include: "emit",
  included: "emit",
  includes: "emit",
  interpolation: "interpolate",
  interpolate: "interpolate",
  interpolated: "interpolate",
  keep: "emit",
  keeping: "emit",
  legacy: "old",
  log: "telemetry",
  logged: "telemetry",
  logging: "telemetry",
  meaning: "semantics",
  monitor: "telemetry",
  monitored: "telemetry",
  monitoring: "telemetry",
  observability: "telemetry",
  observe: "telemetry",
  parameter: "parameterized",
  parameters: "parameterized",
  parameterize: "parameterized",
  parameterized: "parameterized",
  remove: "removed",
  removed: "removed",
  removing: "removed",
  retain: "emit",
  retained: "emit",
  return: "emit",
  returned: "emit",
  returning: "emit",
  semantic: "semantics",
  semantics: "semantics",
  sunset: "timeline",
  telemetry: "telemetry",
  usage: "usage",
  version: "version",
  versioned: "version",
  versioning: "version",
};

const SHORT_KEYWORDS = new Set(["new", "old", "v1", "v2"]);

function canonicalToken(word: string): string {
  const direct = TOKEN_ALIASES[word];
  if (direct) return direct;
  if (word.length > 5 && word.endsWith("ing")) return word.slice(0, -3);
  if (word.length > 4 && word.endsWith("ed")) return word.slice(0, -2);
  if (word.length > 4 && word.endsWith("s")) return word.slice(0, -1);
  return word;
}

function keywordsOf(phrase: string): string[] {
  return normalize(phrase)
    .split(" ")
    .map(canonicalToken)
    .filter((w) => (w.length > 3 || SHORT_KEYWORDS.has(w)) && !STOPWORDS.has(w));
}

function tokenSet(text: string): Set<string> {
  const normalized = normalize(text);
  const set = new Set(
    normalized
      .split(" ")
      .filter(Boolean)
      .map(canonicalToken),
  );

  if (/\b(add|added|adding)\s+(a\s+)?new\b/.test(normalized)) {
    set.add("additive");
  }
  if (/\bkeep(ing)?\s+(the\s+)?old\b/.test(normalized)) {
    set.add("emit");
    set.add("old");
  }
  if (/\b0\s+01\b|\busage\b|\bmonitor/.test(normalized)) {
    set.add("usage");
    set.add("telemetry");
  }
  return set;
}

function coverage(transcript: string, items: string[]): {
  hit: string[];
  miss: string[];
  score: number;
} {
  const tokens = tokenSet(transcript);
  const hit: string[] = [];
  const miss: string[] = [];
  for (const item of items) {
    const kws = keywordsOf(item);
    if (kws.length === 0) {
      miss.push(item);
      continue;
    }
    const matched = kws.filter((kw) => tokens.has(kw)).length;
    // Consider "covered" if enough meaningful keywords appear. Two-word
    // rubric items need both words so generic words do not dominate.
    const needed = kws.length <= 2 ? kws.length : Math.ceil(kws.length * 0.5);
    if (matched >= needed) hit.push(item);
    else miss.push(item);
  }
  return {
    hit,
    miss,
    score: items.length === 0 ? 0 : hit.length / items.length,
  };
}

function bestCoverage(
  transcript: string,
  rubricItems: string[],
  expectedItems: string[],
): ReturnType<typeof coverage> {
  const rubric = coverage(transcript, rubricItems);
  const expected = coverage(transcript, expectedItems);
  return expected.score > rubric.score ? expected : rubric;
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

function isRapidFundamentals(drill: DrillItem): boolean {
  return drill.tags.includes("rapid_fundamentals");
}

function rapidSpeedScore(durationSeconds: number): number {
  if (durationSeconds <= 0) return 0.3;
  if (durationSeconds < 10) return 0.5;
  if (durationSeconds <= 45) return 1;
  if (durationSeconds <= 60) return 0.75;
  if (durationSeconds <= 90) return 0.45;
  return 0.2;
}

function exampleCoverage(transcript: string): number {
  const t = normalize(transcript);
  if (/\b(for example|for instance|such as|like|when|if)\b/.test(t)) {
    return 1;
  }
  if (/\be g\b/.test(t)) return 1;
  return 0;
}

function rapidOfflineGrade(input: GradeInput): GradingResult {
  const { drill, transcript, duration_seconds } = input;
  const rubric: Rubric = drill.rubric;

  const must = bestCoverage(
    transcript,
    rubric.must_have,
    drill.expected_answer.must_have,
  );
  const nice = bestCoverage(
    transcript,
    rubric.nice_to_have,
    drill.expected_answer.nice_to_have,
  );
  const flags = coverage(transcript, rubric.red_flags);

  const mustHaveCoverage =
    rubric.must_have.length === 0 && drill.expected_answer.must_have.length === 0
      ? 0
      : must.score;
  const definition = must.hit.length >= 1 ? 1 : 0;
  const consequence =
    mustHaveCoverage >= 0.6 ? 1 : mustHaveCoverage >= 0.34 ? 0.5 : 0;
  const caveat =
    rubric.nice_to_have.length === 0 &&
    drill.expected_answer.nice_to_have.length === 0
      ? mustHaveCoverage >= 0.8
        ? 1
        : 0
      : nice.score;
  const example = exampleCoverage(transcript);
  const speed = rapidSpeedScore(duration_seconds);
  const clarity = answerClarity(transcript);
  const redFlagPenalty = Math.min(1.5, flags.hit.length * 0.5);

  const rawFive =
    definition + consequence + caveat + example + speed - redFlagPenalty;
  let score = Math.max(0, Math.min(1, rawFive / 5));
  if (caveat < 0.5 && score >= 0.8) score = 0.79;
  if (flags.hit.length > 0) score = Math.min(score, 0.59);

  const missed = [
    ...must.miss,
    ...(caveat < 0.5 ? ["caveat/tradeoff"] : []),
    ...(example < 0.5 ? ["concrete example"] : []),
    ...(speed < 0.75 ? ["20-40 second concise delivery"] : []),
  ];

  const cards: GeneratedCard[] = missed.slice(0, 2).map((point) => ({
    drill_id: drill.id,
    topic: drill.topic,
    subtopic: drill.subtopic,
    front: `For "${drill.question_text.split("\n")[0]}", add the rapid-answer piece: ${point}.`,
    back: drill.canonical_short_answer,
  }));

  return {
    score: round3(score),
    verdict: verdictFromScore(score),
    covered_points: [...must.hit, ...nice.hit].slice(0, 4),
    missed_points: missed,
    ideal_short_answer: drill.canonical_short_answer,
    follow_up_drills: [],
    cards,
    breakdown: {
      must_have_coverage: round3(mustHaveCoverage),
      answer_clarity: round3(clarity),
      tradeoff_coverage: round3(caveat),
      speed_score: round3(speed),
      red_flag_penalty: round3(redFlagPenalty / 5),
    },
  };
}

function offlineGrade(input: GradeInput): GradingResult {
  const { drill, transcript, duration_seconds } = input;
  const rubric: Rubric = drill.rubric;

  const must = bestCoverage(
    transcript,
    rubric.must_have,
    drill.expected_answer.must_have,
  );
  const nice = bestCoverage(
    transcript,
    rubric.nice_to_have,
    drill.expected_answer.nice_to_have,
  );
  const flags = coverage(transcript, rubric.red_flags);

  const mustHaveCoverage =
    rubric.must_have.length === 0 && drill.expected_answer.must_have.length === 0
      ? 0.5
      : must.score;
  const tradeoffCoverage =
    rubric.nice_to_have.length === 0 &&
    drill.expected_answer.nice_to_have.length === 0
      ? 0
      : nice.score;
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
    covered_points: [...must.hit, ...nice.hit].slice(0, 4),
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

async function rapidLlmGrade(input: GradeInput): Promise<GradingResult> {
  const { drill, transcript, duration_seconds } = input;
  const client = openai();

  const system = `You are a strict rapid-fire technical interview grader.
The target answer is 20-40 seconds and must include:
1. Definition or direct answer.
2. Production consequence.
3. Caveat or tradeoff.
4. Tiny concrete example.
5. Concise delivery.
Return JSON only. Score raw_score_0_to_5 honestly; missing caveat should usually be <= 3.95. Dangerous red flags should fail.`;

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
    response_shape: {
      raw_score_0_to_5: "number 0..5",
      verdict: "pass|borderline|fail",
      missed_points: "string[]",
      ideal_short_answer: "string, <=4 sentences",
      follow_up_drills: "string[]",
      cards: '[ { "front": string, "back": string } ]',
      breakdown: {
        must_have_coverage: "0..1 definition/consequence coverage",
        answer_clarity: "0..1 concise delivery clarity",
        tradeoff_coverage: "0..1 caveat/tradeoff coverage",
        speed_score: "0..1 20-40 second target",
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
    temperature: 0.1,
  });

  const content = resp.choices[0]?.message?.content;
  if (!content) throw new Error("Empty LLM response");
  const parsed = JSON.parse(content) as Partial<
    GradingResult & { raw_score_0_to_5: number }
  >;

  const rawFive = Math.max(0, Math.min(5, Number(parsed.raw_score_0_to_5 ?? 0)));
  const score = round3(rawFive / 5);
  const cards = (parsed.cards ?? []).map((c) => ({
    ...c,
    drill_id: drill.id,
    topic: drill.topic,
    subtopic: drill.subtopic,
  }));

  return {
    score,
    verdict: parsed.verdict ?? verdictFromScore(score),
    missed_points: parsed.missed_points ?? [],
    ideal_short_answer:
      parsed.ideal_short_answer ?? drill.canonical_short_answer,
    follow_up_drills: parsed.follow_up_drills ?? [],
    cards,
    usage: usageFromChatCompletion(resp.usage, resp.id, resp.model),
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
    usage: usageFromChatCompletion(resp.usage, resp.id, resp.model),
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

function usageFromChatCompletion(
  raw: unknown,
  responseId: string | null | undefined,
  model: string | null | undefined,
): TokenUsage | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const usage = raw as Record<string, unknown>;
  const promptDetails = readRecord(usage.prompt_tokens_details);
  const completionDetails = readRecord(usage.completion_tokens_details);
  return {
    model: model ?? null,
    response_id: responseId ?? null,
    input_tokens: readNumber(usage.prompt_tokens),
    output_tokens: readNumber(usage.completion_tokens),
    total_tokens: readNumber(usage.total_tokens),
    input_text_tokens: Math.max(
      0,
      readNumber(usage.prompt_tokens) - readNumber(promptDetails.audio_tokens),
    ),
    input_audio_tokens: readNumber(promptDetails.audio_tokens),
    cached_tokens: readNumber(promptDetails.cached_tokens),
    output_text_tokens: Math.max(
      0,
      readNumber(usage.completion_tokens) -
        readNumber(completionDetails.audio_tokens),
    ),
    output_audio_tokens: readNumber(completionDetails.audio_tokens),
    estimated_cost_usd: null,
    raw_usage: usage,
  };
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function readNumber(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

export type Difficulty = 1 | 2 | 3 | 4 | 5;

export type Mode =
  | "mixed"
  | "db_indexes"
  | "system_design"
  | "weak_topics"
  | "mock_interview"
  | "rapid_fundamentals"
  | "betterstack_peterheinz";

export interface Rubric {
  must_have: string[];
  nice_to_have: string[];
  red_flags: string[];
}

export interface PracticalExample {
  use_case: string;
  why_it_fits: string;
  gotcha: string;
}

export interface DrillItem {
  id: string;
  topic: string;
  subtopic: string;
  difficulty: Difficulty;
  trap_type: string | null;
  question_text: string;
  expected_answer: Rubric;
  rubric: Rubric;
  canonical_short_answer: string;
  canonical_deep_answer: string | null;
  examples: PracticalExample[];
  tags: string[];
  is_active: boolean;
  created_at: string;
}

export interface DrillItemRow {
  id: string;
  topic: string;
  subtopic: string;
  difficulty: number;
  trap_type: string | null;
  question_text: string;
  expected_answer: string;
  rubric: string;
  canonical_short_answer: string;
  canonical_deep_answer: string | null;
  examples: string | null;
  tags: string;
  is_active: number;
  created_at: string;
}

export interface DrillAttempt {
  id: string;
  user_id: string;
  session_id: string;
  drill_id: string;
  transcript: string | null;
  duration_seconds: number | null;
  score: number | null;
  verdict: "pass" | "borderline" | "fail" | null;
  missed_points: string[] | null;
  ideal_answer: string | null;
  created_cards: GeneratedCard[] | null;
  created_at: string;
}

export interface GeneratedCard {
  id?: string;
  drill_id?: string;
  front: string;
  back: string;
  topic?: string;
  subtopic?: string;
  next_due_at?: string;
  examples?: PracticalExample[];
}

export interface TokenUsage {
  model?: string | null;
  response_id?: string | null;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  input_text_tokens: number;
  input_audio_tokens: number;
  cached_tokens: number;
  output_text_tokens: number;
  output_audio_tokens: number;
  estimated_cost_usd: number | null;
  raw_usage?: Record<string, unknown>;
}

export interface UserSkillState {
  user_id: string;
  topic: string;
  subtopic: string;
  exposure_count: number;
  last_seen_at: string | null;
  avg_score: number | null;
  weakness_score: number;
  next_due_at: string | null;
}

export interface GradingResult {
  score: number;
  verdict: "pass" | "borderline" | "fail";
  covered_points?: string[];
  missed_points: string[];
  ideal_short_answer: string;
  examples?: PracticalExample[];
  follow_up_drills: string[];
  cards: GeneratedCard[];
  usage?: TokenUsage;
  breakdown: {
    must_have_coverage: number;
    answer_clarity: number;
    tradeoff_coverage: number;
    speed_score: number;
    red_flag_penalty: number;
  };
}

export type GradingEvaluationProvider = "openrouter";

export interface GradingEvaluation {
  id: string;
  user_id: string;
  session_id: string;
  attempt_id: string;
  drill_id: string;
  provider: GradingEvaluationProvider;
  model: string;
  score: number | null;
  verdict: "pass" | "borderline" | "fail" | null;
  covered_points: string[] | null;
  missed_points: string[] | null;
  ideal_answer: string | null;
  raw_json: Record<string, unknown> | null;
  latency_ms: number | null;
  error: string | null;
  estimated_cost_usd: number | null;
  prompt_hash: string;
  created_at: string;
  cached?: boolean;
}

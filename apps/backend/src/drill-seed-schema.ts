import { z } from "zod";

const rubricSchema = z.object({
  must_have: z.array(z.string()),
  nice_to_have: z.array(z.string()),
  red_flags: z.array(z.string()),
});

export const practicalExampleSchema = z.object({
  use_case: z.string().min(1),
  why_it_fits: z.string().min(1),
  gotcha: z.string().min(1),
});

export const drillSeedSchema = z.object({
  id: z.string(),
  topic: z.string(),
  subtopic: z.string(),
  difficulty: z.number().int().min(1).max(5),
  trap_type: z.string().nullable().optional(),
  question_text: z.string(),
  expected_answer: rubricSchema,
  rubric: rubricSchema,
  canonical_short_answer: z.string(),
  canonical_deep_answer: z.string().nullable().optional(),
  examples: z.array(practicalExampleSchema).optional().default([]),
  tags: z.array(z.string()).optional().default([]),
  is_active: z.boolean().optional().default(true),
});

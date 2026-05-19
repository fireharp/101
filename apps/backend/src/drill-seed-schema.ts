import { z } from "zod";

const rubricSchema = z.object({
  must_have: z.array(z.string()),
  nice_to_have: z.array(z.string()),
  red_flags: z.array(z.string()),
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
  tags: z.array(z.string()).optional().default([]),
  is_active: z.boolean().optional().default(true),
});

import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";
import { drills } from "./repo.js";
import { config } from "../config.js";
import type { DrillItem } from "../types.js";

const rubricSchema = z.object({
  must_have: z.array(z.string()),
  nice_to_have: z.array(z.string()),
  red_flags: z.array(z.string()),
});

const drillSchema = z.object({
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

export function seedDrillsFromYaml(dir: string = config.seedsDir): {
  loaded: number;
  files: string[];
} {
  if (!fs.existsSync(dir)) {
    return { loaded: 0, files: [] };
  }
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"));

  let loaded = 0;
  for (const file of files) {
    const full = path.join(dir, file);
    const raw = fs.readFileSync(full, "utf8");
    const parsed = YAML.parse(raw);
    const items = Array.isArray(parsed) ? parsed : [parsed];
    for (const item of items) {
      const result = drillSchema.safeParse(item);
      if (!result.success) {
        console.warn(
          `[seed] skipping invalid drill in ${file}:`,
          result.error.message,
        );
        continue;
      }
      const drill: Omit<DrillItem, "created_at"> = {
        id: result.data.id,
        topic: result.data.topic,
        subtopic: result.data.subtopic,
        difficulty: result.data.difficulty as DrillItem["difficulty"],
        trap_type: result.data.trap_type ?? null,
        question_text: result.data.question_text,
        expected_answer: result.data.expected_answer,
        rubric: result.data.rubric,
        canonical_short_answer: result.data.canonical_short_answer,
        canonical_deep_answer: result.data.canonical_deep_answer ?? null,
        tags: result.data.tags ?? [],
        is_active: result.data.is_active ?? true,
      };
      drills.upsert(drill);
      loaded += 1;
    }
  }
  return { loaded, files };
}

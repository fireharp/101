/**
 * Layer-2 template expander (LOCAL.md §9 layer 2).
 *
 * Reads every YAML file under seeds/templates/, expands each declared
 * `variants:` block by interpolating {placeholders} from `vars` into the
 * template_text, canonical_answer_template, and rubric_template, then
 * upserts the resulting drill_items rows with is_active=true.
 *
 * Run via: pnpm --filter @drill/backend seed:templates
 */
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";
import { runMigrations } from "./db/migrations.js";
import { drills } from "./db/repo.js";
import { config } from "./config.js";
import type { DrillItem, Rubric } from "./types.js";

const rubricTemplateSchema = z.object({
  must_have: z.array(z.string()),
  nice_to_have: z.array(z.string()),
  red_flags: z.array(z.string()),
});

const variantSchema = z.object({
  id: z.string(),
  vars: z.record(z.string(), z.string()),
});

const templateSchema = z.object({
  id: z.string(),
  topic: z.string(),
  subtopic: z.string(),
  difficulty: z.number().int().min(1).max(5),
  trap_type: z.string().nullable().optional(),
  template_text: z.string(),
  canonical_answer_template: z.string(),
  rubric_template: rubricTemplateSchema,
  tags: z.array(z.string()).optional().default([]),
  variants: z.array(variantSchema),
});

function interp(text: string, vars: Record<string, string>): string {
  return text.replace(/\{(\w+)\}/g, (m, key) => vars[key] ?? m);
}

function expandRubric(
  rubric: Rubric,
  vars: Record<string, string>,
): Rubric {
  return {
    must_have: rubric.must_have.map((s) => interp(s, vars)),
    nice_to_have: rubric.nice_to_have.map((s) => interp(s, vars)),
    red_flags: rubric.red_flags.map((s) => interp(s, vars)),
  };
}

export function expandTemplatesFromDir(
  dir: string = path.join(config.seedsDir, "..", "templates"),
): { expanded: number; templates: number; files: string[] } {
  if (!fs.existsSync(dir)) {
    return { expanded: 0, templates: 0, files: [] };
  }
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"));

  let expanded = 0;
  let templates = 0;

  for (const file of files) {
    const raw = fs.readFileSync(path.join(dir, file), "utf8");
    const parsed = YAML.parse(raw);
    const result = templateSchema.safeParse(parsed);
    if (!result.success) {
      console.warn(`[templates] skipping invalid ${file}:`, result.error.message);
      continue;
    }
    templates += 1;
    const t = result.data;
    for (const variant of t.variants) {
      const drill: Omit<DrillItem, "created_at"> = {
        id: variant.id,
        topic: t.topic,
        subtopic: t.subtopic,
        difficulty: t.difficulty as DrillItem["difficulty"],
        trap_type: t.trap_type ?? null,
        question_text: interp(t.template_text, variant.vars),
        expected_answer: expandRubric(t.rubric_template, variant.vars),
        rubric: expandRubric(t.rubric_template, variant.vars),
        canonical_short_answer: interp(
          t.canonical_answer_template,
          variant.vars,
        ),
        canonical_deep_answer: null,
        tags: [...(t.tags ?? []), `tmpl:${t.id}`],
        is_active: true,
      };
      drills.upsert(drill);
      expanded += 1;
    }
  }

  return { expanded, templates, files };
}

// Allow running as a CLI script: `pnpm --filter @drill/backend seed:templates`.
const isMain =
  typeof process !== "undefined" &&
  process.argv[1] &&
  import.meta.url === `file://${process.argv[1]}`;

if (isMain) {
  runMigrations();
  const result = expandTemplatesFromDir();
  console.log(
    `Expanded ${result.expanded} drill variants from ${result.templates} templates in ${result.files.length} files`,
  );
}

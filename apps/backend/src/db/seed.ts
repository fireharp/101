import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { drills } from "./repo.js";
import { config } from "../config.js";
import { drillSeedSchema } from "../drill-seed-schema.js";
import type { DrillItem } from "../types.js";

export { drillSeedSchema };

const drillSchema = drillSeedSchema;

export interface ImportResult {
  ok: boolean;
  imported: number;
  skipped: { id?: string; error: string }[];
}

/**
 * Parse + validate a YAML string of drills and upsert each one. Mirrors the
 * file-walking seedDrillsFromYaml but takes the raw string so HTTP imports
 * can reuse the exact same schema as the seed loader.
 */
export function importDrillsFromYaml(yamlText: string): ImportResult {
  let parsed: unknown;
  try {
    parsed = YAML.parse(yamlText);
  } catch (err) {
    return {
      ok: false,
      imported: 0,
      skipped: [{ error: `YAML parse failed: ${(err as Error).message}` }],
    };
  }
  const items = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
  if (items.length === 0) {
    return {
      ok: false,
      imported: 0,
      skipped: [{ error: "empty document (expected an array of drills)" }],
    };
  }

  let imported = 0;
  const skipped: { id?: string; error: string }[] = [];
  for (const item of items) {
    const result = drillSchema.safeParse(item);
    if (!result.success) {
      skipped.push({
        id:
          item && typeof item === "object" && "id" in item
            ? String((item as { id: unknown }).id)
            : undefined,
        error: result.error.message,
      });
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
    imported += 1;
  }
  return { ok: skipped.length === 0, imported, skipped };
}

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

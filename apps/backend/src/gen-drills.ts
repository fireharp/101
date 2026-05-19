/**
 * Layer-3 generator (LOCAL.md §9 Layer 3): asks an OpenAI text model to
 * propose drill variants for a given topic, validates them with the same
 * schema we use for YAML seeds, and inserts them as is_active=false drafts.
 *
 * Activation is a separate step (DB toggle, an admin UI, or a YAML promote).
 *
 * Usage:
 *   pnpm --filter @drill/backend gen:drills -- --topic database --subtopic indexes --count 5
 *   pnpm --filter @drill/backend gen:drills -- --topic system_design --count 3 --difficulty 4
 *
 * Flags (positional `--flag value` pairs):
 *   --topic       required, e.g. "database", "system_design", "caching"
 *   --subtopic    optional refinement, e.g. "indexes"
 *   --count       integer, default 5
 *   --difficulty  integer 1..5, default 3
 *   --model       overrides OPENAI_GRADING_MODEL
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { runMigrations } from "./db/migrations.js";
import { drills as drillsRepo } from "./db/repo.js";
import { config } from "./config.js";
import { hasOpenAI, openai } from "./services/llm.js";
import type { DrillItem } from "./types.js";

interface CliArgs {
  topic: string;
  subtopic?: string;
  count: number;
  difficulty: number;
  model: string;
}

function parseArgs(argv: string[]): CliArgs {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a) continue;
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        out[key] = next;
        i += 1;
      } else {
        out[key] = "true";
      }
    }
  }
  if (!out.topic) {
    throw new Error("--topic is required");
  }
  return {
    topic: out.topic,
    subtopic: out.subtopic,
    count: Math.max(1, Math.min(20, Number(out.count ?? 5))),
    difficulty: Math.max(1, Math.min(5, Number(out.difficulty ?? 3))),
    model: out.model ?? config.gradingModel,
  };
}

const rubricSchema = z.object({
  must_have: z.array(z.string()).min(2),
  nice_to_have: z.array(z.string()),
  red_flags: z.array(z.string()),
});

const drillSchema = z.object({
  id_slug: z.string().regex(/^[a-z0-9_]+$/),
  topic: z.string(),
  subtopic: z.string(),
  difficulty: z.number().int().min(1).max(5),
  trap_type: z.string().nullable().optional(),
  question_text: z.string().min(20),
  rubric: rubricSchema,
  canonical_short_answer: z.string().min(20),
  tags: z.array(z.string()).optional().default([]),
});

const responseSchema = z.object({
  drills: z.array(drillSchema).min(1),
});

async function generate(args: CliArgs) {
  if (!hasOpenAI()) {
    throw new Error("OPENAI_API_KEY is not set");
  }
  const client = openai();

  const system =
    `You are an expert staff-level interview content author. ` +
    `Produce ${args.count} short, high-quality drills for the topic ` +
    `${args.topic}${args.subtopic ? ` (subtopic: ${args.subtopic})` : ""}, ` +
    `difficulty ${args.difficulty} on a 1..5 scale. ` +
    `Each drill must have a precise, concrete question, a rubric with ` +
    `must_have (concepts a passing answer names), nice_to_have, red_flags ` +
    `(common wrong answers), and a 2-3 sentence canonical_short_answer. ` +
    `Avoid restating these meta-instructions in the question. Output JSON ` +
    `only matching the requested shape.`;

  const user = {
    instructions:
      "Return JSON shaped { drills: [...] }. Each drill: id_slug (kebab_snake_case, unique-looking), topic, subtopic, difficulty, trap_type (one short phrase), question_text, rubric { must_have[], nice_to_have[], red_flags[] }, canonical_short_answer, tags[]. No prose outside JSON.",
    topic: args.topic,
    subtopic: args.subtopic ?? null,
    difficulty: args.difficulty,
    count: args.count,
  };

  const resp = await client.chat.completions.create({
    model: args.model,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: system },
      { role: "user", content: JSON.stringify(user) },
    ],
    temperature: 0.4,
  });
  const content = resp.choices[0]?.message?.content;
  if (!content) throw new Error("Empty LLM response");
  const parsedJson = JSON.parse(content);
  const result = responseSchema.safeParse(parsedJson);
  if (!result.success) {
    throw new Error(
      `Generated payload did not validate: ${result.error.message}\n\n${content.slice(0, 800)}`,
    );
  }

  runMigrations();
  const inserted: DrillItem[] = [];
  for (const d of result.data.drills) {
    const id = `gen_${args.topic}_${d.id_slug}_${randomUUID().slice(0, 6)}`;
    const drill: Omit<DrillItem, "created_at"> = {
      id,
      topic: d.topic,
      subtopic: d.subtopic,
      difficulty: d.difficulty as DrillItem["difficulty"],
      trap_type: d.trap_type ?? null,
      question_text: d.question_text,
      // Layer 3 drafts go in as is_active=false so the rotation engine
      // never serves them until a human flips the bit.
      expected_answer: d.rubric,
      rubric: d.rubric,
      canonical_short_answer: d.canonical_short_answer,
      canonical_deep_answer: null,
      tags: [...(d.tags ?? []), "gen:llm", `gen-difficulty:${d.difficulty}`],
      is_active: false,
    };
    drillsRepo.upsert(drill);
    inserted.push({
      ...drill,
      created_at: new Date().toISOString(),
    });
  }

  return inserted;
}

const isMain =
  typeof process !== "undefined" &&
  process.argv[1] &&
  import.meta.url === `file://${process.argv[1]}`;

if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  generate(args).then(
    (inserted) => {
      console.log(
        `Inserted ${inserted.length} draft drills (is_active=false) for topic=${args.topic}${args.subtopic ? "/" + args.subtopic : ""} via ${args.model}`,
      );
      for (const d of inserted) {
        console.log(`  ${d.id}  d${d.difficulty}  ${d.question_text.slice(0, 80)}`);
      }
      console.log(
        "\nTo activate: edit DB or use a future admin endpoint. Until then they are not served by the rotation engine.",
      );
    },
    (err) => {
      console.error(err.message);
      process.exitCode = 1;
    },
  );
}

export { generate, parseArgs };

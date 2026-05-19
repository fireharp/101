/**
 * Lints every seed YAML file in `seeds/drills/*.yaml` against the canonical
 * drill schema (LOCAL.md §16). Used in CI / `pnpm check` to catch malformed
 * drills before the server boots — otherwise the seed loader just emits a
 * `console.warn` and skips them silently.
 *
 * Two levels:
 *   - **errors** — schema violation, duplicate id, YAML parse failure.
 *     Always exit non-zero.
 *   - **warnings** — content-quality smells (empty rubric, tiny canonical
 *     answer, terse question). Printed but don't fail unless `--strict`
 *     is passed.
 *
 * Usage:
 *   pnpm --filter @drill/backend verify:drills
 *   pnpm --filter @drill/backend verify:drills -- --dir custom/path
 *   pnpm --filter @drill/backend verify:drills -- --strict   # warnings → errors
 */
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { config } from "./config.js";
import { drillSeedSchema } from "./drill-seed-schema.js";

interface Issue {
  level: "error" | "warning";
  file: string;
  drill_id?: string;
  error: string;
}

function parseArgs(argv: string[]): { dir: string; strict: boolean } {
  let dir = config.seedsDir;
  let strict = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--dir" && argv[i + 1]) {
      dir = path.resolve(argv[i + 1]!);
      i += 1;
    } else if (argv[i] === "--strict") {
      strict = true;
    }
  }
  return { dir, strict };
}

// Content quality thresholds. Keep them lenient — these are smells, not
// hard limits. The Layer-1 hand-written drills all easily clear them; if
// the linter starts catching real drills, we should either tune the
// threshold or improve the drill.
const QUALITY = {
  minMustHave: 1,
  minRedFlags: 1,
  minQuestionChars: 30,
  minCanonicalChars: 40,
};

function qualityWarnings(drill: {
  id: string;
  question_text: string;
  canonical_short_answer: string;
  rubric: {
    must_have: string[];
    nice_to_have: string[];
    red_flags: string[];
  };
}): string[] {
  const out: string[] = [];
  if (drill.rubric.must_have.length < QUALITY.minMustHave) {
    out.push(
      `rubric.must_have is empty — a passing answer has no defined target`,
    );
  }
  if (drill.rubric.red_flags.length < QUALITY.minRedFlags) {
    out.push(
      `rubric.red_flags is empty — the grader can't penalize dangerous answers`,
    );
  }
  if (drill.question_text.trim().length < QUALITY.minQuestionChars) {
    out.push(
      `question_text is ${drill.question_text.trim().length} chars (< ${QUALITY.minQuestionChars}); spell out the scenario`,
    );
  }
  if (drill.canonical_short_answer.trim().length < QUALITY.minCanonicalChars) {
    out.push(
      `canonical_short_answer is ${drill.canonical_short_answer.trim().length} chars (< ${QUALITY.minCanonicalChars}); the ideal answer should be a 2–4 sentence paragraph`,
    );
  }
  return out;
}

export function verifyDrills(dir: string): {
  files: number;
  drills: number;
  errors: Issue[];
  warnings: Issue[];
} {
  if (!fs.existsSync(dir)) {
    return {
      files: 0,
      drills: 0,
      errors: [
        { level: "error", file: dir, error: "seeds dir does not exist" },
      ],
      warnings: [],
    };
  }

  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"))
    .sort();

  const errors: Issue[] = [];
  const warnings: Issue[] = [];
  let drillCount = 0;
  const seenIds = new Map<string, string>();

  for (const file of files) {
    const full = path.join(dir, file);
    const raw = fs.readFileSync(full, "utf8");

    let parsed: unknown;
    try {
      parsed = YAML.parse(raw);
    } catch (err) {
      errors.push({
        level: "error",
        file,
        error: `YAML parse failed: ${(err as Error).message}`,
      });
      continue;
    }

    const items = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
    if (items.length === 0) {
      errors.push({ level: "error", file, error: "empty document" });
      continue;
    }

    for (const item of items) {
      const itemId =
        item && typeof item === "object" && "id" in item
          ? String((item as { id: unknown }).id)
          : undefined;

      const result = drillSeedSchema.safeParse(item);
      if (!result.success) {
        errors.push({
          level: "error",
          file,
          drill_id: itemId,
          error: result.error.issues
            .map(
              (issue) =>
                `${issue.path.join(".") || "(root)"}: ${issue.message}`,
            )
            .join("; "),
        });
        continue;
      }

      const dup = seenIds.get(result.data.id);
      if (dup) {
        errors.push({
          level: "error",
          file,
          drill_id: result.data.id,
          error: `duplicate drill id (first defined in ${dup})`,
        });
      } else {
        seenIds.set(result.data.id, file);
      }

      for (const w of qualityWarnings(result.data)) {
        warnings.push({
          level: "warning",
          file,
          drill_id: result.data.id,
          error: w,
        });
      }

      drillCount += 1;
    }
  }

  return { files: files.length, drills: drillCount, errors, warnings };
}

const isMain =
  typeof process !== "undefined" &&
  process.argv[1] &&
  import.meta.url === `file://${process.argv[1]}`;

if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  const report = verifyDrills(args.dir);

  const errorsExist = report.errors.length > 0;
  const warningsExist = report.warnings.length > 0;
  const failOnWarnings = args.strict && warningsExist;

  if (!errorsExist && !warningsExist) {
    console.log(
      `verify:drills OK — ${report.drills} drills validated across ${report.files} files`,
    );
    process.exit(0);
  }

  if (errorsExist) {
    console.error(
      `verify:drills ERRORS — ${report.errors.length} schema/integrity issue(s):`,
    );
    for (const issue of report.errors) {
      console.error(
        `  ✗ ${issue.file}${issue.drill_id ? ` [${issue.drill_id}]` : ""}: ${issue.error}`,
      );
    }
  }

  if (warningsExist) {
    const stream = args.strict ? console.error : console.warn;
    stream(
      `verify:drills WARNINGS — ${report.warnings.length} content-quality smell(s)${
        args.strict ? " (treated as errors under --strict)" : ""
      }:`,
    );
    for (const issue of report.warnings) {
      stream(
        `  ⚠ ${issue.file}${issue.drill_id ? ` [${issue.drill_id}]` : ""}: ${issue.error}`,
      );
    }
  }

  if (errorsExist || failOnWarnings) {
    process.exit(1);
  }
  console.log(
    `verify:drills OK — ${report.drills} drills validated across ${report.files} files (${report.warnings.length} warning(s), --strict to fail on them)`,
  );
  process.exit(0);
}

/**
 * Lints every seed YAML file in `seeds/drills/*.yaml` against the canonical
 * drill schema (LOCAL.md §16). Used in CI / `pnpm check` to catch malformed
 * drills before the server boots — otherwise the seed loader just emits a
 * `console.warn` and skips them silently.
 *
 * Exits 0 when every file parses and every drill validates, 1 otherwise.
 *
 * Usage:
 *   pnpm --filter @drill/backend verify:drills
 *   pnpm --filter @drill/backend verify:drills -- --dir custom/path
 */
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { config } from "./config.js";
import { drillSeedSchema } from "./drill-seed-schema.js";

interface Issue {
  file: string;
  drill_id?: string;
  error: string;
}

function parseArgs(argv: string[]): { dir: string } {
  let dir = config.seedsDir;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--dir" && argv[i + 1]) {
      dir = path.resolve(argv[i + 1]!);
      i += 1;
    }
  }
  return { dir };
}

export function verifyDrills(dir: string): {
  files: number;
  drills: number;
  issues: Issue[];
} {
  if (!fs.existsSync(dir)) {
    return {
      files: 0,
      drills: 0,
      issues: [{ file: dir, error: "seeds dir does not exist" }],
    };
  }

  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"))
    .sort();

  const issues: Issue[] = [];
  let drillCount = 0;
  const seenIds = new Map<string, string>();

  for (const file of files) {
    const full = path.join(dir, file);
    const raw = fs.readFileSync(full, "utf8");

    let parsed: unknown;
    try {
      parsed = YAML.parse(raw);
    } catch (err) {
      issues.push({
        file,
        error: `YAML parse failed: ${(err as Error).message}`,
      });
      continue;
    }

    const items = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
    if (items.length === 0) {
      issues.push({ file, error: "empty document" });
      continue;
    }

    for (const item of items) {
      const itemId =
        item && typeof item === "object" && "id" in item
          ? String((item as { id: unknown }).id)
          : undefined;

      const result = drillSeedSchema.safeParse(item);
      if (!result.success) {
        issues.push({
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
        issues.push({
          file,
          drill_id: result.data.id,
          error: `duplicate drill id (first defined in ${dup})`,
        });
      } else {
        seenIds.set(result.data.id, file);
      }

      drillCount += 1;
    }
  }

  return { files: files.length, drills: drillCount, issues };
}

const isMain =
  typeof process !== "undefined" &&
  process.argv[1] &&
  import.meta.url === `file://${process.argv[1]}`;

if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  const report = verifyDrills(args.dir);
  if (report.issues.length === 0) {
    console.log(
      `verify:drills OK — ${report.drills} drills validated across ${report.files} files`,
    );
    process.exit(0);
  }
  console.error(
    `verify:drills FAIL — ${report.issues.length} issue(s) across ${report.files} files:`,
  );
  for (const issue of report.issues) {
    console.error(
      `  ${issue.file}${issue.drill_id ? ` [${issue.drill_id}]` : ""}: ${issue.error}`,
    );
  }
  process.exit(1);
}

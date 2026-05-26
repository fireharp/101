import fs from "node:fs";
import { attempts, drills } from "../db/repo.js";
import { evaluateAttemptWithOpenRouter } from "./shadow-grading.js";
import type { OpenRouterModelPolicy } from "../services/openrouter.js";

export type BenchmarkSource = "historical" | "curated" | "attempt";

export interface GraderBenchmarkOptions {
  source: BenchmarkSource;
  modelsPolicy: OpenRouterModelPolicy;
  limit: number;
  userId?: string;
  attemptId?: string;
  curatedFile?: string;
  force?: boolean;
  fetchImpl?: typeof fetch;
}

export async function runGraderBenchmark(opts: GraderBenchmarkOptions): Promise<{
  attempts: number;
  evaluations: number;
  errors: number;
}> {
  const candidates = benchmarkCandidates(opts);
  let evaluations = 0;
  let errors = 0;
  for (const attempt of candidates) {
    const drill = drills.get(attempt.drill_id);
    if (!drill) {
      errors += 1;
      continue;
    }
    const result = await evaluateAttemptWithOpenRouter({
      attempt,
      drill,
      modelsPolicy: opts.modelsPolicy,
      force: opts.force ?? false,
      fetchImpl: opts.fetchImpl,
    });
    evaluations += result.evaluations.length;
    errors += result.evaluations.filter((e) => e.error).length;
  }
  return { attempts: candidates.length, evaluations, errors };
}

function benchmarkCandidates(opts: GraderBenchmarkOptions) {
  if (opts.source === "attempt") {
    if (!opts.attemptId) throw new Error("--attempt-id is required for attempt source");
    return attempts.listBenchmarkCandidates({
      attempt_id: opts.attemptId,
      limit: 1,
      user_id: opts.userId,
    });
  }
  if (opts.source === "curated") {
    const ids = readCuratedAttemptIds(opts.curatedFile ?? "data/grader-benchmark-curated.jsonl");
    const rows = ids
      .slice(0, opts.limit)
      .flatMap((id) =>
        attempts.listBenchmarkCandidates({
          attempt_id: id,
          limit: 1,
          user_id: opts.userId,
        }),
      );
    return rows;
  }
  return attempts.listBenchmarkCandidates({
    user_id: opts.userId,
    limit: opts.limit,
  });
}

function readCuratedAttemptIds(file: string): string[] {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      if (!line.startsWith("{")) return line;
      const parsed = JSON.parse(line) as { attempt_id?: string };
      if (!parsed.attempt_id) throw new Error(`Missing attempt_id in ${file}`);
      return parsed.attempt_id;
    });
}

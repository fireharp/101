import { runMigrations } from "./db/migrations.js";
import { runGraderBenchmark, type BenchmarkSource } from "./engines/grader-benchmark.js";
import { hasOpenRouter, type OpenRouterModelPolicy } from "./services/openrouter.js";

runMigrations();

const args = parseArgs(process.argv.slice(2));
if (!hasOpenRouter()) {
  console.error("OPENROUTER_API_KEY not configured on backend");
  process.exit(1);
}

const result = await runGraderBenchmark({
  source: args.source,
  modelsPolicy: args.modelsPolicy,
  limit: args.limit,
  userId: args.userId,
  attemptId: args.attemptId,
  curatedFile: args.file,
  force: args.force,
});
console.log(JSON.stringify(result, null, 2));

function parseArgs(argv: string[]): {
  source: BenchmarkSource;
  modelsPolicy: OpenRouterModelPolicy;
  limit: number;
  userId?: string;
  attemptId?: string;
  file?: string;
  force: boolean;
} {
  const out = {
    source: "historical" as BenchmarkSource,
    modelsPolicy: "free-pinned" as OpenRouterModelPolicy,
    limit: 25,
    force: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const next = argv[i + 1];
    if (arg === "--source" && next) {
      if (!["historical", "curated", "attempt"].includes(next)) {
        throw new Error(`Invalid --source ${next}`);
      }
      out.source = next as BenchmarkSource;
      i += 1;
    } else if (arg === "--models" && next) {
      if (!["free-pinned", "free-router"].includes(next)) {
        throw new Error(`Invalid --models ${next}`);
      }
      out.modelsPolicy = next as OpenRouterModelPolicy;
      i += 1;
    } else if (arg === "--limit" && next) {
      out.limit = Math.max(1, Math.min(500, Number(next)));
      i += 1;
    } else if (arg === "--user-id" && next) {
      (out as typeof out & { userId: string }).userId = next;
      i += 1;
    } else if (arg === "--attempt-id" && next) {
      (out as typeof out & { attemptId: string }).attemptId = next;
      i += 1;
    } else if (arg === "--file" && next) {
      (out as typeof out & { file: string }).file = next;
      i += 1;
    } else if (arg === "--force") {
      out.force = true;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument ${arg}`);
    }
  }
  return out;
}

function printHelp(): void {
  console.log(`Usage:
  pnpm --filter @drill/backend bench:grader --source historical --models free-pinned --limit 25
  pnpm --filter @drill/backend bench:grader --source attempt --attempt-id <id>
  pnpm --filter @drill/backend bench:grader --source curated --file data/grader-benchmark-curated.jsonl
`);
}

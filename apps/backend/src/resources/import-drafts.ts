import fs from "node:fs";
import path from "node:path";
import { importDrillsFromYaml } from "../db/seed.js";
import { runMigrations } from "../db/migrations.js";
import { resourceDataRoot } from "./paths.js";

interface Args {
  run: string;
  resource?: string;
}

function parseArgs(argv: string[]): Args {
  const out: Record<string, string> = { run: "latest" };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--") continue;
    if (!arg?.startsWith("--")) continue;
    const key = arg.slice(2);
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`);
    out[key] = value;
    i += 1;
  }
  return { run: out.run ?? "latest", resource: out.resource };
}

function latestRunForResource(resourceDir: string): string | null {
  if (!fs.existsSync(resourceDir)) return null;
  const dirs = fs
    .readdirSync(resourceDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) =>
      fs.existsSync(path.join(resourceDir, name, "draft_drills.yaml")),
    )
    .sort();
  return dirs.at(-1) ?? null;
}

function findDraftFiles(args: Args): string[] {
  const root = resourceDataRoot();
  const resources = args.resource
    ? [args.resource]
    : fs.existsSync(root)
      ? fs
          .readdirSync(root, { withFileTypes: true })
          .filter((entry) => entry.isDirectory() && !entry.name.startsWith("_"))
          .map((entry) => entry.name)
      : [];
  const files: string[] = [];
  for (const resource of resources) {
    const resourceDir = path.join(root, resource);
    const runId = args.run === "latest" ? latestRunForResource(resourceDir) : args.run;
    if (!runId) continue;
    const file = path.join(resourceDir, runId, "draft_drills.yaml");
    if (fs.existsSync(file)) files.push(file);
  }
  return files;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const files = findDraftFiles(args);
  if (files.length === 0) {
    throw new Error("No draft_drills.yaml files found for the requested run");
  }
  runMigrations();
  const results = files.map((file) => ({
    file,
    result: importDrillsFromYaml(fs.readFileSync(file, "utf8")),
  }));
  console.log(JSON.stringify({ ok: results.every((item) => item.result.ok), results }, null, 2));
}

main();

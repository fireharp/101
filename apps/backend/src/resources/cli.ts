import fs from "node:fs";
import path from "node:path";
import { importDrillsFromYaml } from "../db/seed.js";
import { runMigrations } from "../db/migrations.js";
import { loadResourceManifest, selectResources } from "./manifest.js";
import { findRepoRoot, timestampId } from "./paths.js";
import {
  assessResource,
  extractResourceDocuments,
  runResourcePipeline,
  runDirForResource,
  writeRunMeta,
} from "./pipeline.js";
import { draftDrillsToYaml, documentsToDraftDrills } from "./drills.js";
import type { ResourceArtifacts } from "./pipeline.js";

function ensureDir(dir: string, dryRun = false): void {
  if (!dryRun) fs.mkdirSync(dir, { recursive: true });
}

function writeJson(pathname: string, value: unknown, dryRun = false): void {
  if (!dryRun) {
    fs.writeFileSync(pathname, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  }
}

function writeText(pathname: string, value: string, dryRun = false): void {
  if (!dryRun) fs.writeFileSync(pathname, value, "utf8");
}

function jsonl(rows: unknown[]): string {
  return rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length ? "\n" : "");
}

interface Args {
  phase: "assess" | "extract" | "generate-drills" | "smoke" | "all";
  resource: string;
  limit?: number;
  run: string;
  dryRun: boolean;
  importDrafts: boolean;
}

function parseArgs(argv: string[]): Args {
  const out: Record<string, string | boolean> = {
    phase: "all",
    resource: "all",
    run: timestampId(),
    dryRun: false,
    importDrafts: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg) continue;
    if (arg === "--") continue;
    if (arg === "--dry-run") {
      out.dryRun = true;
    } else if (arg === "--import") {
      out.importDrafts = true;
    } else if (arg.startsWith("--")) {
      const key = arg.slice(2).replace(/-([a-z])/g, (_m, c: string) =>
        c.toUpperCase(),
      );
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`${arg} requires a value`);
      }
      out[key] = value;
      i += 1;
    }
  }
  const phase = String(out.phase) as Args["phase"];
  if (!["assess", "extract", "generate-drills", "smoke", "all"].includes(phase)) {
    throw new Error(`Unknown phase '${phase}'`);
  }
  const limit =
    out.limit === undefined ? undefined : Math.max(1, Number(out.limit));
  if (limit !== undefined && !Number.isFinite(limit)) {
    throw new Error("--limit must be a number");
  }
  return {
    phase,
    resource: String(out.resource),
    limit,
    run: String(out.run),
    dryRun: out.dryRun === true,
    importDrafts: out.importDrafts === true,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const repoRoot = findRepoRoot();
  const manifest = loadResourceManifest();
  const resources = selectResources(manifest, args.resource);
  const limit = args.phase === "smoke" ? args.limit ?? 3 : args.limit;
  const options = {
    repoRoot,
    runId: args.run,
    limit,
    dryRun: args.dryRun,
    phase: args.phase,
  };

  if (args.phase === "assess") {
    const artifacts: ResourceArtifacts[] = [];
    for (const resource of resources) {
      const runDir = runDirForResource(resource, options);
      ensureDir(runDir, args.dryRun);
      const assessment = await assessResource(resource, options);
      writeJson(`${runDir}/assessment.json`, assessment, args.dryRun);
      writeJson(
        `${runDir}/meta.json`,
        {
          run_id: path.basename(runDir),
          resource: resource.slug,
          created_at: new Date().toISOString(),
          phase: args.phase,
          documents: 0,
          draft_drills: 0,
          dry_run: args.dryRun,
        },
        args.dryRun,
      );
      artifacts.push({ resource, runDir, assessment });
    }
    const meta = writeRunMeta(artifacts, options);
    console.log(JSON.stringify({ ok: true, run: meta, resources: artifacts }, null, 2));
    return;
  }

  if (args.phase === "extract" || args.phase === "generate-drills") {
    const artifacts = [];
    for (const resource of resources) {
      const runDir = runDirForResource(resource, options);
      ensureDir(runDir, args.dryRun);
      const assessment = await assessResource(resource, options);
      writeJson(`${runDir}/assessment.json`, assessment, args.dryRun);
      const documents = await extractResourceDocuments(resource, assessment);
      writeText(`${runDir}/documents.jsonl`, jsonl(documents), args.dryRun);
      const drafts = documentsToDraftDrills(documents, limit);
      if (args.phase === "generate-drills") {
        writeText(`${runDir}/draft_drills.yaml`, draftDrillsToYaml(drafts), args.dryRun);
      }
      writeJson(
        `${runDir}/meta.json`,
        {
          run_id: path.basename(runDir),
          resource: resource.slug,
          created_at: new Date().toISOString(),
          phase: args.phase,
          documents: documents.length,
          draft_drills: args.phase === "generate-drills" ? drafts.length : 0,
          dry_run: args.dryRun,
        },
        args.dryRun,
      );
      artifacts.push({
        resource,
        runDir,
        assessment,
        documents,
        draftCount: drafts.length,
      });
      if (args.phase === "generate-drills") {
        console.log(draftDrillsToYaml(drafts));
      } else {
        console.log(JSON.stringify({ resource: resource.slug, documents }, null, 2));
      }
    }
    writeRunMeta(artifacts, options);
    return;
  }

  const artifacts = [];
  for (const resource of resources) {
    const result = await runResourcePipeline(resource, options);
    artifacts.push(result);
  }
  const meta = writeRunMeta(artifacts, options);

  let imported = 0;
  if (args.importDrafts && !args.dryRun) {
    runMigrations();
    for (const artifact of artifacts) {
      const yamlPath = `${artifact.runDir}/draft_drills.yaml`;
      const result = importDrillsFromYaml(
        await import("node:fs").then((fs) => fs.readFileSync(yamlPath, "utf8")),
      );
      imported += result.imported;
      if (!result.ok) {
        console.error(JSON.stringify({ resource: artifact.resource.slug, skipped: result.skipped }, null, 2));
      }
    }
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        run: meta,
        resources: artifacts.map((artifact) => ({
          slug: artifact.resource.slug,
          run_dir: artifact.runDir,
          selected_paths: artifact.assessment?.selected_paths.length ?? 0,
          documents: artifact.documents?.length ?? 0,
          draft_drills: artifact.draftCount ?? 0,
        })),
        imported,
      },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});

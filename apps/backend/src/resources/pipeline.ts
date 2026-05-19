import fs from "node:fs";
import path from "node:path";
import { draftDrillsToYaml, documentsToDraftDrills } from "./drills.js";
import {
  fetchGitHubRawMarkdown,
  githubBlobUrl,
  listGitHubMarkdownPaths,
} from "./github.js";
import {
  hashText,
  inferDifficulty,
  inferTopics,
  splitMarkdownSections,
} from "./markdown.js";
import { ensureResourceSkill, readResourceSkill } from "./manifest.js";
import { findRepoRoot, resourceDataRoot, timestampId } from "./paths.js";
import type {
  ResourceAssessment,
  ResourceConfig,
  ResourceDocument,
  ResourceRunMeta,
} from "./types.js";

export interface PipelineOptions {
  repoRoot?: string;
  runId?: string;
  limit?: number;
  dryRun?: boolean;
  phase?: string;
}

export interface ResourceArtifacts {
  resource: ResourceConfig;
  runDir: string;
  assessment?: ResourceAssessment;
  documents?: ResourceDocument[];
  draftCount?: number;
}

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

function fallbackTitle(filePath: string): string {
  const parts = filePath.split("/");
  const stem = parts.at(-2) && parts.at(-1) === "README.md" ? parts.at(-2)! : parts.at(-1)!;
  return stem
    .replace(/\.(md|mdx)$/i, "")
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

export async function assessResource(
  resource: ResourceConfig,
  options: PipelineOptions = {},
): Promise<ResourceAssessment> {
  ensureResourceSkill(resource, undefined, options.dryRun);
  const listed = await listGitHubMarkdownPaths(resource);
  const selected = options.limit
    ? listed.selected.slice(0, options.limit)
    : listed.selected;
  const skill = readResourceSkill(resource);
  return {
    resource_slug: resource.slug,
    resource_title: resource.title,
    assessed_at: new Date().toISOString(),
    type: resource.type,
    method: "github_raw",
    skill_path: skill.path,
    skill_exists: skill.exists,
    selected_paths: selected,
    skipped_paths: listed.skipped,
    reasons: [
      "GitHub tree API provides deterministic file discovery.",
      "raw.githubusercontent.com provides stable Markdown bytes.",
      "Browser extraction is unnecessary for public GitHub Markdown.",
    ],
    warnings: listed.truncated ? ["GitHub tree response was truncated."] : [],
  };
}

export async function extractResourceDocuments(
  resource: ResourceConfig,
  assessment: ResourceAssessment,
): Promise<ResourceDocument[]> {
  const extractedAt = new Date().toISOString();
  const docs: ResourceDocument[] = [];
  const seen = new Set<string>();

  for (const filePath of assessment.selected_paths) {
    const markdown = await fetchGitHubRawMarkdown(resource, filePath);
    const sections = splitMarkdownSections(markdown, fallbackTitle(filePath));
    for (const section of sections) {
      const hash = hashText(`${resource.slug}\n${filePath}\n${section.title}\n${section.text}`);
      if (seen.has(hash)) continue;
      seen.add(hash);
      const sourceId = `${resource.slug}:${filePath}:${hash}`;
      docs.push({
        source_id: sourceId,
        source_slug: resource.slug,
        source_title: resource.title,
        source_url: githubBlobUrl(resource, filePath),
        repo: resource.repo,
        branch: resource.branch,
        path: filePath,
        title: section.title,
        section: section.section,
        text: section.text,
        topics: inferTopics(resource.title, filePath, section.title, section.text),
        difficulty_hint: inferDifficulty(section.text, section.title),
        extract_method: "github_raw",
        hash,
        extracted_at: extractedAt,
      });
    }
  }

  return docs;
}

export function runDirForResource(
  resource: ResourceConfig,
  options: PipelineOptions = {},
): string {
  const repoRoot = options.repoRoot ?? findRepoRoot();
  const runId = options.runId ?? timestampId();
  return path.join(resourceDataRoot(repoRoot), resource.slug, runId);
}

export async function runResourcePipeline(
  resource: ResourceConfig,
  options: PipelineOptions = {},
): Promise<ResourceArtifacts> {
  const runDir = runDirForResource(resource, options);
  ensureDir(runDir, options.dryRun);

  const assessment = await assessResource(resource, options);
  writeJson(path.join(runDir, "assessment.json"), assessment, options.dryRun);

  const documents = await extractResourceDocuments(resource, assessment);
  writeText(path.join(runDir, "documents.jsonl"), jsonl(documents), options.dryRun);

  const drafts = documentsToDraftDrills(documents, options.limit);
  writeText(path.join(runDir, "draft_drills.yaml"), draftDrillsToYaml(drafts), options.dryRun);

  writeJson(
    path.join(runDir, "meta.json"),
    {
      run_id: path.basename(runDir),
      resource: resource.slug,
      created_at: new Date().toISOString(),
      documents: documents.length,
      draft_drills: drafts.length,
      dry_run: options.dryRun === true,
    },
    options.dryRun,
  );

  return { resource, runDir, assessment, documents, draftCount: drafts.length };
}

export function writeRunMeta(
  resources: ResourceArtifacts[],
  options: PipelineOptions,
): ResourceRunMeta {
  const repoRoot = options.repoRoot ?? findRepoRoot();
  const runId = options.runId ?? timestampId();
  const meta: ResourceRunMeta = {
    run_id: runId,
    created_at: new Date().toISOString(),
    resources: resources.map((item) => item.resource.slug),
    limit: options.limit ?? null,
    phase: options.phase ?? "all",
    artifact_dirs: resources.map((item) => item.runDir),
  };
  const summaryPath = path.join(resourceDataRoot(repoRoot), "_runs", `${runId}.json`);
  ensureDir(path.dirname(summaryPath), options.dryRun);
  writeJson(summaryPath, meta, options.dryRun);
  return meta;
}

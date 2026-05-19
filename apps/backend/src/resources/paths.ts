import fs from "node:fs";
import path from "node:path";

export function findRepoRoot(start = process.cwd()): string {
  let dir = path.resolve(start);
  while (true) {
    if (fs.existsSync(path.join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return path.resolve(start);
    dir = parent;
  }
}

export function resourceSkillRoot(repoRoot = findRepoRoot()): string {
  return path.join(repoRoot, ".agents", "skills", "resource-extraction");
}

export function defaultManifestPath(repoRoot = findRepoRoot()): string {
  return path.join(resourceSkillRoot(repoRoot), "resources.json");
}

export function resourceDataRoot(repoRoot = findRepoRoot()): string {
  return path.join(repoRoot, "data", "resources");
}

export function timestampId(date = new Date()): string {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

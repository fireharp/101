#!/usr/bin/env node
/**
 * Wipe the local SQLite database and re-seed it from YAML.
 *
 *   pnpm dev:reset          # confirms before deleting
 *   pnpm dev:reset --yes    # skip confirmation
 *
 * Safety:
 *   - Refuses to run if a dev server is listening on PORT (default 4000)
 *     — kill it first so the seed runs against the fresh DB.
 *   - Reads DATABASE_PATH from the repo-root .env, then
 *     apps/backend/.env, then the backend default
 *     (`apps/backend/data/drill.db`).
 *   - Removes the .db file plus its -wal / -shm / -journal siblings.
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = new Set(process.argv.slice(2));
const skipConfirm = args.has("--yes") || args.has("-y");

function readEnv(envPath) {
  if (!fs.existsSync(envPath)) return {};
  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
  const out = {};
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    const val = line
      .slice(eq + 1)
      .trim()
      .replace(/^['"]|['"]$/g, "");
    if (key) out[key] = val;
  }
  return out;
}

const rootEnv = readEnv(path.join(repoRoot, ".env"));
const backendEnv = readEnv(path.join(repoRoot, "apps/backend/.env"));
const env = { ...process.env, ...backendEnv, ...rootEnv };

const port = Number(env.PORT ?? 4000);
const dbPath = path.resolve(
  env.DATABASE_PATH ?? path.join(repoRoot, "apps/backend/data/drill.db"),
);

async function isPortBusy(p) {
  try {
    const res = await fetch(`http://127.0.0.1:${p}/api/health`, {
      signal: AbortSignal.timeout(800),
    });
    return res.ok || res.status > 0;
  } catch {
    return false;
  }
}

if (await isPortBusy(port)) {
  console.error(
    `dev:reset refusing to run — something is listening on port ${port}. ` +
      `Stop the dev server first (Ctrl-C in the terminal running 'pnpm dev').`,
  );
  process.exit(2);
}

const exists = fs.existsSync(dbPath);
if (!exists) {
  console.log(`No DB at ${dbPath} — nothing to wipe, will just seed.`);
} else {
  const size = fs.statSync(dbPath).size;
  console.log(`Found DB at ${dbPath} (${(size / 1024).toFixed(1)} KB)`);
}

if (exists && !skipConfirm) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const answer = await rl.question(
    "Delete this DB and re-seed? (y/N) ",
  );
  rl.close();
  if (answer.trim().toLowerCase() !== "y") {
    console.log("Aborted.");
    process.exit(1);
  }
}

if (exists) {
  for (const ext of ["", "-wal", "-shm", "-journal"]) {
    const p = `${dbPath}${ext}`;
    if (fs.existsSync(p)) {
      fs.rmSync(p);
      console.log(`  removed ${path.relative(repoRoot, p)}`);
    }
  }
}

function run(label, cmd) {
  console.log(`▶ ${label}…`);
  const r = spawnSync("pnpm", cmd, {
    cwd: repoRoot,
    stdio: "inherit",
  });
  if (r.status !== 0) {
    console.error(`${label} failed with exit ${r.status}`);
    process.exit(r.status ?? 1);
  }
}

run("seed drills", ["--filter", "@drill/backend", "seed"]);
run("expand templates", ["--filter", "@drill/backend", "seed:templates"]);

console.log("\ndev:reset OK — DB wiped and reseeded from YAML.");

#!/usr/bin/env node
/**
 * Environment diagnostic for the drill-coach repo. Runs a series of
 * checks and prints one line each with a fix hint. Exits 0 when every
 * required check passes (warnings allowed); exits 1 otherwise.
 *
 *   pnpm doctor
 */
import fs from "node:fs";
import os from "node:os";
import net from "node:net";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Resolve from the backend workspace, since pnpm hoists native modules
// under each package's node_modules rather than the workspace root.
const require = createRequire(
  `${repoRoot}/apps/backend/package.json`,
);

const checks = [];

function record(level, name, detail, hint) {
  checks.push({ level, name, detail, hint });
}

function readEnv(envPath) {
  if (!fs.existsSync(envPath)) return {};
  const out = {};
  for (const raw of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    const val = line
      .slice(eq + 1)
      .trim()
      .replace(/^['"]|['"]$/g, "");
    out[key] = val;
  }
  return out;
}

// ── Node version ────────────────────────────────────────────────────
const nodeMajor = Number(process.versions.node.split(".")[0] ?? 0);
if (nodeMajor >= 22) {
  record("ok", "node", `v${process.versions.node}`);
} else {
  record(
    "fail",
    "node",
    `v${process.versions.node} (need >= 22)`,
    "Install Node 22 with nvm: `nvm install 22 && nvm use 22`",
  );
}

// ── pnpm version ────────────────────────────────────────────────────
const pnpmRes = spawnSync("pnpm", ["--version"], { encoding: "utf8" });
if (pnpmRes.status === 0) {
  const ver = (pnpmRes.stdout || "").trim();
  const major = Number(ver.split(".")[0] ?? 0);
  if (major >= 10) {
    record("ok", "pnpm", `v${ver}`);
  } else {
    record(
      "warn",
      "pnpm",
      `v${ver} (project pinned to 10)`,
      "`corepack use pnpm@10` to match the lockfile",
    );
  }
} else {
  record("fail", "pnpm", "not installed", "`npm i -g pnpm@10`");
}

// ── .env / OPENAI_API_KEY ────────────────────────────────────────────
const rootEnv = readEnv(path.join(repoRoot, ".env"));
const backendEnv = readEnv(path.join(repoRoot, "apps/backend/.env"));
const env = { ...process.env, ...backendEnv, ...rootEnv };
const envPath = fs.existsSync(path.join(repoRoot, ".env"))
  ? ".env"
  : fs.existsSync(path.join(repoRoot, "apps/backend/.env"))
    ? "apps/backend/.env"
    : null;
if (!envPath) {
  record(
    "warn",
    "env file",
    "no .env found",
    "`cp apps/backend/.env.example .env` and fill in OPENAI_API_KEY",
  );
} else {
  record("ok", "env file", envPath);
}
if (env.OPENAI_API_KEY && env.OPENAI_API_KEY.length > 10) {
  record(
    "ok",
    "OPENAI_API_KEY",
    `set (${env.OPENAI_API_KEY.slice(0, 7)}…)`,
  );
} else {
  record(
    "warn",
    "OPENAI_API_KEY",
    "unset (offline grader + tests still work)",
    "Put your key in .env to unlock realtime voice + LLM grading",
  );
}
if (env.OPENAI_REALTIME_PROMPT_ID) {
  record(
    "ok",
    "OPENAI_REALTIME_PROMPT_ID",
    `${env.OPENAI_REALTIME_PROMPT_ID}${env.OPENAI_REALTIME_PROMPT_VERSION ? ` v${env.OPENAI_REALTIME_PROMPT_VERSION}` : ""}`,
  );
} else {
  record(
    "ok",
    "OPENAI_REALTIME_PROMPT_ID",
    "(unset — local DRILL_COACH_INSTRUCTIONS fallback in use)",
  );
}

// ── better-sqlite3 native binding ───────────────────────────────────
try {
  const Database = require("better-sqlite3");
  const tmp = new Database(":memory:");
  tmp.exec("CREATE TABLE t (a INT)");
  tmp.close();
  record("ok", "better-sqlite3", "native binding loads");
} catch (err) {
  record(
    "fail",
    "better-sqlite3",
    (err && err.message) || String(err),
    "`pnpm rebuild -r better-sqlite3` to recompile the native module",
  );
}

// ── DB path writable ────────────────────────────────────────────────
const dbPath = path.resolve(
  env.DATABASE_PATH ?? path.join(repoRoot, "apps/backend/data/drill.db"),
);
const dbDir = path.dirname(dbPath);
try {
  fs.mkdirSync(dbDir, { recursive: true });
  const probe = path.join(dbDir, `.doctor-${Date.now()}`);
  fs.writeFileSync(probe, "ok");
  fs.rmSync(probe);
  record(
    "ok",
    "db path",
    `${path.relative(repoRoot, dbPath)} (writable)`,
  );
} catch (err) {
  record(
    "fail",
    "db path",
    `${path.relative(repoRoot, dbPath)} not writable`,
    `Check filesystem permissions on ${dbDir}`,
  );
}

// ── Backend port availability ───────────────────────────────────────
// First ask the port whether something is *actually* serving the drill
// API on it. The backend binds IPv6 dual-stack, so a pure
// net.createServer().listen check can falsely report "free" while the
// server is happily running on the same port.
const port = Number(env.PORT ?? 4000);
async function backendOnPort(p) {
  try {
    const res = await fetch(`http://127.0.0.1:${p}/api/health`, {
      signal: AbortSignal.timeout(800),
    });
    if (!res.ok) return null;
    return (await res.json()).ok === true ? "ours" : "other";
  } catch {
    return null;
  }
}
const portState = await backendOnPort(port);
if (portState === "ours") {
  record(
    "ok",
    `port ${port}`,
    "in use by our backend (`/api/health` ok)",
  );
} else if (portState === "other") {
  record(
    "warn",
    `port ${port}`,
    "something else is serving on this port",
    `\`lsof -i :${port}\` and stop it before \`pnpm dev\``,
  );
} else {
  // Confirm it's actually free with a bind probe.
  const portFree = await new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen(port, () => server.close(() => resolve(true)));
  });
  if (portFree) {
    record("ok", `port ${port}`, "free");
  } else {
    record(
      "warn",
      `port ${port}`,
      "occupied but not by our backend",
      `\`lsof -i :${port}\` to investigate`,
    );
  }
}

// ── Playwright Chromium ─────────────────────────────────────────────
const playwrightRes = spawnSync(
  "pnpm",
  ["exec", "playwright", "--version"],
  { cwd: repoRoot, encoding: "utf8" },
);
if (playwrightRes.status === 0) {
  record(
    "ok",
    "playwright",
    (playwrightRes.stdout || "").trim() || "installed",
  );
  // Check chromium cache exists.
  const cachePath = path.join(
    os.homedir(),
    "Library/Caches/ms-playwright",
  );
  const linuxCache = path.join(os.homedir(), ".cache/ms-playwright");
  const looksInstalled =
    fs.existsSync(cachePath) || fs.existsSync(linuxCache);
  if (!looksInstalled) {
    record(
      "warn",
      "playwright chromium",
      "browser binaries not detected",
      "`pnpm exec playwright install --with-deps chromium` (smoke:browser needs it)",
    );
  } else {
    record("ok", "playwright chromium", "browser cache present");
  }
} else {
  record(
    "fail",
    "playwright",
    "not installed",
    "`pnpm install` should pull it in",
  );
}

// ── Lockfile and node_modules sanity ────────────────────────────────
if (!fs.existsSync(path.join(repoRoot, "node_modules"))) {
  record(
    "fail",
    "node_modules",
    "not installed",
    "Run `pnpm install --frozen-lockfile`",
  );
} else {
  record("ok", "node_modules", "present");
}

// ── Drill bank present ──────────────────────────────────────────────
const seedDir = path.join(repoRoot, "apps/backend/seeds/drills");
if (fs.existsSync(seedDir)) {
  const files = fs.readdirSync(seedDir).filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"));
  if (files.length > 0) {
    record("ok", "drill seeds", `${files.length} YAML files`);
  } else {
    record(
      "warn",
      "drill seeds",
      "no YAML files in seeds/drills",
      "Drill bank will be empty — add seeds or re-pull the repo",
    );
  }
} else {
  record(
    "fail",
    "drill seeds",
    "seeds/drills/ missing",
    "Did you clone the full repo? Run `git pull`.",
  );
}

// ── Render summary ──────────────────────────────────────────────────
const SYMBOL = { ok: "✓", warn: "⚠", fail: "✗" };
const COLOR = { ok: "\x1b[32m", warn: "\x1b[33m", fail: "\x1b[31m" };
const RESET = "\x1b[0m";
const supportsColor =
  process.stdout.isTTY && process.env.TERM !== "dumb" && !process.env.NO_COLOR;

let nameWidth = 0;
for (const c of checks) nameWidth = Math.max(nameWidth, c.name.length);

console.log();
for (const c of checks) {
  const sym = SYMBOL[c.level];
  const prefix = supportsColor ? `${COLOR[c.level]}${sym}${RESET}` : sym;
  const name = c.name.padEnd(nameWidth + 1);
  console.log(`  ${prefix} ${name}  ${c.detail}`);
  if (c.hint && (c.level === "warn" || c.level === "fail")) {
    console.log(`        → ${c.hint}`);
  }
}
console.log();
const failed = checks.filter((c) => c.level === "fail").length;
const warned = checks.filter((c) => c.level === "warn").length;
const ok = checks.filter((c) => c.level === "ok").length;
console.log(`  ${ok} ok, ${warned} warning, ${failed} fail`);
process.exit(failed > 0 ? 1 : 0);

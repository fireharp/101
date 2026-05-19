import express, { type Express } from "express";
import cors from "cors";
import { config } from "./config.js";
import { runMigrations } from "./db/migrations.js";
import { seedDrillsFromYaml } from "./db/seed.js";
import { drills } from "./db/repo.js";
import { apiRouter } from "./routes/index.js";

export function createApp(): Express {
  const app = express();

  app.use(express.json({ limit: "256kb" }));
  // Accept raw YAML for /api/drills/import so the same file the export
  // endpoint produces can be POSTed straight back.
  app.use(
    express.text({
      limit: "512kb",
      type: [
        "application/x-yaml",
        "application/yaml",
        "text/yaml",
        "text/x-yaml",
      ],
    }),
  );
  app.use(
    cors({
      origin: (origin, cb) => {
        if (!origin) return cb(null, true);
        if (origin === config.frontendOrigin) return cb(null, true);
        // Allow Vite preview / local network too in dev.
        if (origin.startsWith("http://localhost")) return cb(null, true);
        if (origin.startsWith("http://127.0.0.1")) return cb(null, true);
        cb(new Error(`origin ${origin} not allowed`));
      },
      credentials: false,
    }),
  );

  app.use("/api", apiRouter);

  app.get("/", (_req, res) => {
    res.type("text/plain").send(
      "GPT Realtime Interview Drill Coach — backend. See /api/health.",
    );
  });

  return app;
}

// Run directly only when invoked as the entry point, not when imported.
const isMain =
  typeof process !== "undefined" &&
  process.argv[1] &&
  import.meta.url === `file://${process.argv[1]}`;

if (isMain) {
  runMigrations();
  const seedResult = seedDrillsFromYaml();
  console.log(
    `[seed] loaded ${seedResult.loaded} drills from ${seedResult.files.length} files; ${drills.count()} total in DB`,
  );
  const app = createApp();
  app.listen(config.port, () => {
    console.log(
      `[server] listening on http://localhost:${config.port} (openai=${
        config.openaiApiKey ? "yes" : "no"
      }, offline_grader=${config.useOfflineGrader})`,
    );
  });
}

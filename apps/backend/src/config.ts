import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Load .env from backend, then fall back to repo root so a single shared
// .env at the workspace root works in dev.
dotenv.config({ path: path.join(__dirname, "..", ".env") });
dotenv.config({ path: path.join(__dirname, "..", "..", "..", ".env") });

export const config = {
  port: Number(process.env.PORT ?? 4000),
  dbPath: path.resolve(
    process.env.DATABASE_PATH ?? path.join(__dirname, "..", "data", "drill.db"),
  ),
  seedsDir: path.resolve(path.join(__dirname, "..", "seeds", "drills")),
  openaiApiKey: process.env.OPENAI_API_KEY ?? "",
  realtimeModel: process.env.OPENAI_REALTIME_MODEL ?? "gpt-realtime-2",
  gradingModel: process.env.OPENAI_GRADING_MODEL ?? "gpt-4.1-mini",
  realtimeVoice: process.env.REALTIME_VOICE ?? "marin",
  frontendOrigin: process.env.FRONTEND_ORIGIN ?? "http://localhost:5173",
  useOfflineGrader:
    process.env.USE_OFFLINE_GRADER === "1" || !process.env.OPENAI_API_KEY,
};

import { runMigrations } from "./db/migrations.js";
import { seedDrillsFromYaml } from "./db/seed.js";
import { drills } from "./db/repo.js";

runMigrations();
const result = seedDrillsFromYaml();
console.log(
  `Seeded ${result.loaded} drills from ${result.files.length} files. Total in DB: ${drills.count()}`,
);

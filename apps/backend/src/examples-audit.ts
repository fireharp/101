import { runMigrations } from "./db/migrations.js";
import { db } from "./db/index.js";

interface MissingDrillRow {
  id: string;
  topic: string;
  subtopic: string;
}

interface MissingCardRow {
  id: string;
  drill_id: string | null;
  front: string;
}

function isEmptyJsonColumn(column = "examples"): string {
  return `(${column} IS NULL OR ${column} = '' OR ${column} = '[]')`;
}

function main(argv: string[]): void {
  const backfillCards = argv.includes("--backfill-cards");
  runMigrations();

  let backfilledCards = 0;
  if (backfillCards) {
    const info = db
      .prepare(
        `UPDATE generated_cards
            SET examples = (
              SELECT di.examples
                FROM drill_items di
               WHERE di.id = generated_cards.drill_id
            )
          WHERE ${isEmptyJsonColumn("generated_cards.examples")}
            AND drill_id IS NOT NULL
            AND EXISTS (
              SELECT 1
                FROM drill_items di
               WHERE di.id = generated_cards.drill_id
                 AND NOT ${isEmptyJsonColumn("di.examples")}
            )`,
      )
      .run();
    backfilledCards = info.changes;
  }

  const missingDrills = db
    .prepare(
      `SELECT id, topic, subtopic
         FROM drill_items
        WHERE is_active = 1
          AND ${isEmptyJsonColumn()}
        ORDER BY topic, subtopic, id`,
    )
    .all() as MissingDrillRow[];

  const missingCards = db
    .prepare(
      `SELECT id, drill_id, front
         FROM generated_cards
        WHERE ${isEmptyJsonColumn()}
        ORDER BY datetime(created_at) DESC
        LIMIT 50`,
    )
    .all() as MissingCardRow[];

  console.log(
    JSON.stringify(
      {
        backfilled_cards: backfilledCards,
        missing_active_drills: missingDrills.length,
        missing_generated_cards_sample: missingCards.length,
        drills: missingDrills.slice(0, 50),
        cards: missingCards.map((c) => ({
          id: c.id,
          drill_id: c.drill_id,
          front: c.front.slice(0, 120),
        })),
      },
      null,
      2,
    ),
  );
}

main(process.argv.slice(2));

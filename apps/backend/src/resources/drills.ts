import YAML from "yaml";
import { drillSeedSchema } from "../drill-seed-schema.js";
import type { DrillItem } from "../types.js";
import { hashText, keywordHints } from "./markdown.js";
import type { ResourceDocument } from "./types.js";

type DraftDrill = Omit<DrillItem, "created_at">;

function topicFromDocument(document: ResourceDocument): string {
  if (document.topics.includes("database")) return "database";
  if (document.topics.includes("caching")) return "caching";
  if (document.topics.includes("messaging")) return "messaging";
  if (document.topics.includes("networking")) return "networking";
  if (document.topics.includes("security")) return "security";
  if (document.topics.includes("observability")) return "observability";
  if (document.topics.includes("distributed")) return "distributed";
  return "system_design";
}

function summarize(text: string): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= 360) return compact;
  return `${compact.slice(0, 357).trim()}...`;
}

export function documentsToDraftDrills(
  documents: ResourceDocument[],
  perResourceLimit?: number,
): DraftDrill[] {
  const counts = new Map<string, number>();
  const drills: DraftDrill[] = [];

  for (const document of documents) {
    const count = counts.get(document.source_slug) ?? 0;
    if (perResourceLimit !== undefined && count >= perResourceLimit) continue;
    counts.set(document.source_slug, count + 1);

    const topic = topicFromDocument(document);
    const hints = keywordHints(document.title, document.section, document.text);
    const mustHave = [
      `explain ${document.title}`,
      "state the core mechanism",
      "name one tradeoff or failure mode",
    ];
    const id = `ext_${document.source_slug.replace(/-/g, "_")}_${hashText(
      document.source_id,
    )}`;
    drills.push({
      id,
      topic,
      subtopic: hints[0] ?? "concepts",
      difficulty: document.difficulty_hint,
      trap_type: "source_summary",
      question_text: `Explain ${document.title} in a system design interview. What should a strong answer cover?`,
      expected_answer: {
        must_have: mustHave,
        nice_to_have: hints.slice(1, 5).map((hint) => `mention ${hint}`),
        red_flags: [
          "only gives definitions without design consequences",
          "ignores tradeoffs and failure modes",
        ],
      },
      rubric: {
        must_have: mustHave,
        nice_to_have: hints.slice(1, 5).map((hint) => `mention ${hint}`),
        red_flags: [
          "only gives definitions without design consequences",
          "ignores tradeoffs and failure modes",
        ],
      },
      canonical_short_answer: summarize(document.text),
      canonical_deep_answer: `Source: ${document.source_url}\n\n${document.text}`,
      examples: [],
      tags: [
        "extracted",
        "source:github",
        `source_repo:${document.repo}`,
        `source_resource:${document.source_slug}`,
        `source_path:${document.path}`,
      ],
      is_active: false,
    });
  }

  return drills;
}

export function draftDrillsToYaml(drills: DraftDrill[]): string {
  for (const drill of drills) {
    const result = drillSeedSchema.safeParse(drill);
    if (!result.success) {
      throw new Error(`Invalid generated drill ${drill.id}: ${result.error.message}`);
    }
  }
  return YAML.stringify(drills, { lineWidth: 0 });
}

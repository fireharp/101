import { z } from "zod";

export const resourceTypeSchema = z.literal("github_repo");

export const resourceConfigSchema = z.object({
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  title: z.string().min(1),
  type: resourceTypeSchema,
  url: z.string().url(),
  repo: z.string().regex(/^[^/\s]+\/[^/\s]+$/),
  branch: z.string().min(1),
  skill_path: z.string().min(1),
  include_paths: z.array(z.string()).min(1),
  exclude_paths: z.array(z.string()).default([]),
  tags: z.array(z.string()).default([]),
});

export const resourceManifestSchema = z.object({
  version: z.literal(1),
  resources: z.array(resourceConfigSchema),
});

export type ResourceConfig = z.infer<typeof resourceConfigSchema>;
export type ResourceManifest = z.infer<typeof resourceManifestSchema>;

export interface ResourceAssessment {
  resource_slug: string;
  resource_title: string;
  assessed_at: string;
  type: "github_repo";
  method: "github_raw";
  skill_path: string;
  skill_exists: boolean;
  selected_paths: string[];
  skipped_paths: number;
  reasons: string[];
  warnings: string[];
}

export interface ResourceDocument {
  source_id: string;
  source_slug: string;
  source_title: string;
  source_url: string;
  repo: string;
  branch: string;
  path: string;
  title: string;
  section: string;
  text: string;
  topics: string[];
  difficulty_hint: 1 | 2 | 3 | 4 | 5;
  extract_method: "github_raw";
  hash: string;
  extracted_at: string;
}

export interface ResourceRunMeta {
  run_id: string;
  created_at: string;
  resources: string[];
  limit: number | null;
  phase: string;
  artifact_dirs: string[];
}

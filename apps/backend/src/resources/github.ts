import https from "node:https";
import { matchesAny, selectPaths } from "./glob.js";
import type { ResourceConfig } from "./types.js";

interface GitHubTreeItem {
  path?: string;
  type?: string;
}

interface GitHubTreeResponse {
  tree?: GitHubTreeItem[];
  truncated?: boolean;
}

function requestText(url: string, accept = "application/json"): Promise<string> {
  const token = process.env.GITHUB_TOKEN;
  const headers: Record<string, string> = {
    accept,
    "user-agent": "drill-resource-extractor",
  };
  if (token) {
    headers.authorization = `Bearer ${token}`;
    headers["x-github-api-version"] = "2022-11-28";
  }
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers }, (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => {
          const status = res.statusCode ?? 0;
          if (status < 200 || status >= 300) {
            reject(new Error(`GET ${url} failed with ${status}: ${body.slice(0, 300)}`));
            return;
          }
          resolve(body);
        });
      })
      .on("error", reject);
  });
}

export async function listGitHubMarkdownPaths(
  resource: ResourceConfig,
): Promise<{ selected: string[]; skipped: number; truncated: boolean }> {
  const url = `https://api.github.com/repos/${resource.repo}/git/trees/${encodeURIComponent(
    resource.branch,
  )}?recursive=1`;
  const body = await requestText(url);
  const parsed = JSON.parse(body) as GitHubTreeResponse;
  const markdown = (parsed.tree ?? [])
    .filter((item) => item.type === "blob" && item.path)
    .map((item) => item.path!)
    .filter((item) => /\.(md|mdx)$/i.test(item));
  const selected = selectPaths(
    markdown,
    resource.include_paths,
    resource.exclude_paths,
  );
  const skipped = markdown.filter(
    (item) =>
      !matchesAny(item, resource.include_paths) ||
      matchesAny(item, resource.exclude_paths),
  ).length;
  return { selected, skipped, truncated: parsed.truncated === true };
}

export function rawGitHubUrl(resource: ResourceConfig, filePath: string): string {
  return `https://raw.githubusercontent.com/${resource.repo}/${encodeURIComponent(
    resource.branch,
  )}/${filePath
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/")}`;
}

export function githubBlobUrl(resource: ResourceConfig, filePath: string): string {
  return `https://github.com/${resource.repo}/blob/${encodeURIComponent(
    resource.branch,
  )}/${filePath}`;
}

export async function fetchGitHubRawMarkdown(
  resource: ResourceConfig,
  filePath: string,
): Promise<string> {
  return requestText(rawGitHubUrl(resource, filePath), "text/plain");
}

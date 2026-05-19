import crypto from "node:crypto";

export interface MarkdownSection {
  title: string;
  section: string;
  text: string;
}

const stopwords = new Set([
  "the",
  "and",
  "for",
  "with",
  "from",
  "into",
  "that",
  "this",
  "what",
  "when",
  "how",
  "does",
  "your",
  "you",
  "are",
  "can",
  "vs",
  "via",
  "use",
  "using",
]);

export function hashText(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex").slice(0, 16);
}

function stripMarkdownNoise(markdown: string): string {
  return markdown
    .replace(/^---[\s\S]*?---\s*/u, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<p[^>]*>[\s\S]*?<\/p>/gi, "")
    .replace(/<img\b[^>]*>/gi, "")
    .replace(/\r\n/g, "\n");
}

function cleanText(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)]\(([^)]+)\)/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*\d+\.\s+/gm, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function splitMarkdownSections(
  markdown: string,
  fallbackTitle: string,
): MarkdownSection[] {
  const cleaned = stripMarkdownNoise(markdown);
  const lines = cleaned.split("\n");
  const sections: { title: string; level: number; lines: string[] }[] = [];
  let current: { title: string; level: number; lines: string[] } | null = null;

  for (const line of lines) {
    const heading = /^(#{1,3})\s+(.+?)\s*$/.exec(line);
    if (heading) {
      if (current) sections.push(current);
      current = {
        title: heading[2]?.replace(/#+$/, "").trim() || fallbackTitle,
        level: heading[1]?.length ?? 1,
        lines: [],
      };
      continue;
    }
    if (!current) {
      current = { title: fallbackTitle, level: 1, lines: [] };
    }
    current.lines.push(line);
  }
  if (current) sections.push(current);

  return sections
    .map((section) => {
      const text = cleanText(section.lines.join("\n"));
      return {
        title: section.title,
        section: `${"#".repeat(section.level)} ${section.title}`,
        text,
      };
    })
    .filter((section) => section.text.length >= 120);
}

export function inferTopics(...values: string[]): string[] {
  const joined = values.join(" ").toLowerCase();
  const topics = new Set<string>();
  const mappings: [string, string[]][] = [
    ["database", ["database", "sql", "postgres", "mysql", "index", "storage"]],
    ["caching", ["cache", "cdn", "redis", "memcached"]],
    ["distributed", ["distributed", "consensus", "replication", "partition"]],
    ["messaging", ["queue", "stream", "kafka", "pub/sub", "message"]],
    ["networking", ["http", "tcp", "dns", "load balancer", "proxy"]],
    ["security", ["auth", "security", "encryption", "tls", "rate limit"]],
    ["observability", ["logging", "metrics", "tracing", "monitoring"]],
    ["system_design", ["system design", "scalability", "availability", "architecture"]],
  ];
  for (const [topic, needles] of mappings) {
    if (needles.some((needle) => joined.includes(needle))) topics.add(topic);
  }
  if (topics.size === 0) topics.add("system_design");
  return [...topics].sort();
}

export function inferDifficulty(text: string, title = ""): 1 | 2 | 3 | 4 | 5 {
  const joined = `${title} ${text}`.toLowerCase();
  let score = 2;
  if (joined.length > 1200) score += 1;
  if (/\b(consensus|sharding|partition|distributed|throughput|replication)\b/.test(joined)) {
    score += 1;
  }
  if (/\b(trade-?off|failure|consistency|availability|latency)\b/.test(joined)) {
    score += 1;
  }
  return Math.max(1, Math.min(5, score)) as 1 | 2 | 3 | 4 | 5;
}

export function keywordHints(...values: string[]): string[] {
  const words = values
    .join(" ")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length >= 4 && !stopwords.has(word));
  return [...new Set(words)].slice(0, 6);
}

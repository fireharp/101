const regexSpecial = /[|\\{}()[\]^$+?.]/g;

function escapeRegex(char: string): string {
  return char.replace(regexSpecial, "\\$&");
}

export function globToRegExp(pattern: string): RegExp {
  let out = "^";
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i];
    const next = pattern[i + 1];
    const afterNext = pattern[i + 2];
    if (char === "*" && next === "*" && afterNext === "/") {
      out += "(?:.*/)?";
      i += 2;
    } else if (char === "*" && next === "*") {
      out += ".*";
      i += 1;
    } else if (char === "*") {
      out += "[^/]*";
    } else if (char === "?") {
      out += "[^/]";
    } else {
      out += escapeRegex(char ?? "");
    }
  }
  out += "$";
  return new RegExp(out);
}

export function matchesAny(path: string, patterns: string[]): boolean {
  return patterns.some((pattern) => globToRegExp(pattern).test(path));
}

export function selectPaths(
  paths: string[],
  includePatterns: string[],
  excludePatterns: string[],
): string[] {
  return paths
    .filter((item) => matchesAny(item, includePatterns))
    .filter((item) => !matchesAny(item, excludePatterns))
    .sort();
}

#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NAME="${1:-}"

if [[ -z "$NAME" ]]; then
  echo "usage: ./scripts/new-task.sh <task-name>" >&2
  exit 1
fi

slug="$(echo "$NAME" | tr '[:upper:]' '[:lower:]' | tr -cs 'a-z0-9-' '-' | sed 's/^-//;s/-$//')"
next="$(find "$ROOT/tasks" -maxdepth 1 -mindepth 1 -type d 2>/dev/null | wc -l | tr -d ' ')"
next=$((next + 1))
dir="$ROOT/tasks/$(printf '%02d' "$next")-$slug"

if [[ -e "$dir" ]]; then
  echo "task directory already exists: $dir" >&2
  exit 1
fi

mkdir -p "$dir"

cat >"$dir/README.md" <<EOF
# $(printf '%02d' "$next")-$slug

Describe the exercise here.

## Run

\`\`\`bash
make run $(printf '%02d' "$next")-$slug
\`\`\`

## Test

\`\`\`bash
make test $(printf '%02d' "$next")-$slug
\`\`\`
EOF

cat >"$dir/main.go" <<EOF
package main

import "fmt"

func main() {
	fmt.Println("TODO: implement $(printf '%02d' "$next")-$slug")
}
EOF

cat >"$dir/main_test.go" <<EOF
package main

import "testing"

func TestPlaceholder(t *testing.T) {
	t.Skip("replace with real tests")
}
EOF

echo "created $dir"
echo "next: make run $(printf '%02d' "$next")-$slug"

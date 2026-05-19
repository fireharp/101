---
name: resource-extraction
description: Build and run reusable extraction skills for learning resources, then turn normalized content into inactive interview-drill drafts.
metadata:
  short-description: Reusable resource extraction
---

# Resource Extraction

Use this skill when adding, assessing, or refreshing external learning resources.

## Workflow

1. Check `resources.json` for an existing resource entry.
2. Check `domain-skills/<resource>/scraping.md` before exploring.
3. Run a small assessment/sample before bulk extraction.
4. Record reusable facts in the resource skill: access paths, APIs/raw URLs,
   selectors, pagination, rate limits, traps, and output shape.
5. Extract deterministic normalized records into ignored `data/resources/`.
6. Generate inactive drill drafts; activate only after review.

## Commands

From the repo root:

```bash
pnpm --filter @drill/backend extract:resources -- --resource fixtures --limit 3
pnpm --filter @drill/backend import:resource-drafts -- --run latest
```

Useful options:

```bash
--phase assess|extract|generate-drills|smoke|all
--resource <slug|fixtures|all>
--limit <n>
--run <run-id>
--dry-run
--import
```

## Rules

- Prefer HTTP/API/raw content over browser automation.
- Use browser extraction only when static access is insufficient.
- Keep high-level assessment adaptive, but make repeat extraction deterministic.
- Resource skills are durable tracked artifacts; run outputs are ignored.
- Generated drills must be `is_active: false`.

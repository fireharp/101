# System Design 101 — Extraction

Resource: `ByteByteGoHq/system-design-101`

## Access Path

- Use GitHub API for tree listing.
- Use `raw.githubusercontent.com` for Markdown content.
- Default branch is `main`.

## Include

- `README.md`
- `data/categories/*.md`
- `data/guides/*.md`

## Notes

- The repo is Markdown-heavy and already grouped by category.
- `data/guides/*.md` provides compact guide pages that map cleanly to drill
  drafts.
- Browser extraction is not needed for GitHub-hosted Markdown.

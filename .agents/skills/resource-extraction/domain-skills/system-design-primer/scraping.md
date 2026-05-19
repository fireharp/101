# The System Design Primer — Extraction

Resource: `donnemartin/system-design-primer`

## Access Path

- Use GitHub API for tree listing.
- Use `raw.githubusercontent.com` for Markdown content.
- Default branch is `master`.

## Include

- `README.md`
- `solutions/system_design/**/README.md`

## Exclude

- Translated README variants such as `README-zh-Hans.md`.
- Images, EPUB assets, flashcard packages, and non-English solution files.

## Notes

- The top-level README is a concept guide and index.
- `solutions/system_design/*/README.md` pages are better drill sources because
  they contain concrete interview prompts and solution outlines.
- Browser extraction is not needed for GitHub-hosted Markdown.

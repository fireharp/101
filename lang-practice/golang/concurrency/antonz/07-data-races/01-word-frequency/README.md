# 01 Word Frequency

Source: [Gist of Go: Data-Races](https://antonz.org/go-concurrency/data-races/)

Fix concurrent map writes by using per-goroutine maps and merge.

Implement in `exercise.go`. Helpers (if any) are in `support.go`. **No solutions in this repo** — check the book when stuck.

## Test

```bash
make test concurrency/antonz/07-data-races/01-word-frequency
```

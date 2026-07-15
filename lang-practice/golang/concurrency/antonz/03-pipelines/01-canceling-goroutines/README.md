# 01 Canceling Goroutines

Source: [Gist of Go: Pipelines](https://antonz.org/go-concurrency/pipelines/)

Add cancel-channel support so `generate` stops when cancel is closed.

Implement in `exercise.go`. Helpers (if any) are in `support.go`. **No solutions in this repo** — check the book when stuck.

## Test

```bash
make test concurrency/antonz/03-pipelines/01-canceling-goroutines
```

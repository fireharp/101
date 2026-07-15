# 01 Atomic Counter

Source: [Gist of Go: Atomics](https://antonz.org/go-concurrency/atomics/)

Fix the counter using sync/atomic so 5 goroutines × 10000 increments = 50000.

Implement in `exercise.go`. Helpers (if any) are in `support.go`. **No solutions in this repo** — check the book when stuck.

## Test

```bash
make test concurrency/antonz/11-atomics/01-atomic-counter
```

# 04 Panic Recover

Source: [Gist of Go: Wait-Groups](https://antonz.org/go-concurrency/wait-groups/)

Implement `RunConcSafe(funcs ...func()) error` that catches panics in worker goroutines.

Implement in `exercise.go`. Helpers (if any) are in `support.go`. **No solutions in this repo** — check the book when stuck.

## Test

```bash
make test concurrency/antonz/06-wait-groups/04-panic-recover
```

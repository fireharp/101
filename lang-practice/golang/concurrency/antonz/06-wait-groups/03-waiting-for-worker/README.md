# 03 Waiting For Worker

Source: [Gist of Go: Wait-Groups](https://antonz.org/go-concurrency/wait-groups/)

Use nested wait groups so main waits for a waiter that waits for workers.

Implement in `exercise.go`. Helpers (if any) are in `support.go`. **No solutions in this repo** — check the book when stuck.

## Test

```bash
make test concurrency/antonz/06-wait-groups/03-waiting-for-worker
```

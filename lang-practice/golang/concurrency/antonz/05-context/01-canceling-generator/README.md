# 01 Canceling Generator

Source: [Gist of Go: Context](https://antonz.org/go-concurrency/context/)

Rewrite word generator to accept `context.Context` and stop when ctx is canceled.

Implement in `exercise.go`. Helpers (if any) are in `support.go`. **No solutions in this repo** — check the book when stuck.

## Test

```bash
make test concurrency/antonz/05-context/01-canceling-generator
```

# 04-reader-worker

Source: [Gist of Go: Goroutines — Reader and worker](https://antonz.org/go-concurrency/goroutines/)

Split the pipeline into three stages:

1. **Reader goroutine** — fetch words from `next`, send to `pending`.
2. **Worker goroutine** — read from `pending`, count digits, send `pair` to `counted`.
3. **Outer function** — read from `counted` and build `stats`.

Use empty-word sentinels on both channels.

## Test

```bash
make test concurrency/antonz/01-goroutines/04-reader-worker
```

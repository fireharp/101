# 02 Merging N Channels

Source: [Gist of Go: Pipelines](https://antonz.org/go-concurrency/pipelines/)

Implement `merge(channels ...<-chan int) <-chan int` merging all inputs concurrently.

Implement in `exercise.go`. Helpers (if any) are in `support.go`. **No solutions in this repo** — check the book when stuck.

## Test

```bash
make test concurrency/antonz/03-pipelines/02-merging-n-channels
```

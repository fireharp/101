# 01 Throttle Backpressure

Source: [Gist of Go: Time](https://antonz.org/go-concurrency/time/)

Implement `throttle(n int, fn func()) (handle func() error, wait func())` with backpressure (return busy error when full).

Implement in `exercise.go`. Helpers (if any) are in `support.go`. **No solutions in this repo** — check the book when stuck.

## Test

```bash
make test concurrency/antonz/04-time/01-throttle-backpressure
```

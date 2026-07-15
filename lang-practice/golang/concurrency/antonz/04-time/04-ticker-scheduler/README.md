# 04 Ticker Scheduler

Source: [Gist of Go: Time](https://antonz.org/go-concurrency/time/)

Implement `schedule(interval time.Duration, n int, fn func(time.Time)) int` that calls fn on each tick, n times total.

Implement in `exercise.go`. Helpers (if any) are in `support.go`. **No solutions in this repo** — check the book when stuck.

## Test

```bash
make test concurrency/antonz/04-time/04-ticker-scheduler
```

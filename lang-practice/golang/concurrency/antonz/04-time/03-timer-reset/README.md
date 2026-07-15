# 03 Timer Reset

Source: [Gist of Go: Time](https://antonz.org/go-concurrency/time/)

Implement `consumer(cancel <-chan struct{}, in <-chan struct{})` using one reusable timer instead of time.After per iteration.

Implement in `exercise.go`. Helpers (if any) are in `support.go`. **No solutions in this repo** — check the book when stuck.

## Test

```bash
make test concurrency/antonz/04-time/03-timer-reset
```

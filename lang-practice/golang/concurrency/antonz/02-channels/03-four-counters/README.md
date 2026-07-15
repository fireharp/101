# 03 Four Counters

Source: [Gist of Go: Channels](https://antonz.org/go-concurrency/channels/)

Run four concurrent counters that each increment a shared total safely using channels (no mutex).

Implement in `exercise.go`. Helpers (if any) are in `support.go`. **No solutions in this repo** — check the book when stuck.

## Test

```bash
make test concurrency/antonz/02-channels/03-four-counters
```

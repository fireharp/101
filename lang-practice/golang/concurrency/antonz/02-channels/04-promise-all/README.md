# 04 Promise All

Source: [Gist of Go: Channels](https://antonz.org/go-concurrency/channels/)

Implement `all(channels ...<-chan int) []int` that waits for one value from each channel.

Implement in `exercise.go`. Helpers (if any) are in `support.go`. **No solutions in this repo** — check the book when stuck.

## Test

```bash
make test concurrency/antonz/02-channels/04-promise-all
```

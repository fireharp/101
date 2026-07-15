# 01-basic-goroutines

Source: [Hugo-cruz/golang-concurrency-exercises](https://github.com/Hugo-cruz/golang-concurrency-exercises)

Implement `PrintOneToTen()` — spawn goroutines that collect values 1 through 10 concurrently, then return them sorted.

Use `sync.WaitGroup` to wait for all goroutines before returning.

## Test

```bash
make test concurrency/hugo-cruz/01-basic-goroutines
```

# 01-counting-digits

Source: [Gist of Go: Goroutines — Counting digits](https://antonz.org/go-concurrency/goroutines/)

Implement `countDigitsInWords` in `exercise.go`. For each word in the phrase, count digits in a **separate goroutine**. Store results in the provided `sync.Map` via `syncStats.Store(word, count)`.

Use `sync.WaitGroup` (or `wg.Go()` on Go 1.25+) to wait for all goroutines before returning.

Do **not** use channels for this exercise. No solution code is in this repo — see the [book chapter](https://antonz.org/go-concurrency/goroutines/) if stuck.

## Test

```bash
make test concurrency/antonz/01-goroutines/01-counting-digits
```

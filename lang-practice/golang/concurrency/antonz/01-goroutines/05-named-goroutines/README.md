# 05-named-goroutines

Source: [Gist of Go: Goroutines — Named goroutines](https://antonz.org/go-concurrency/goroutines/)

Refactor the reader/worker pipeline into named functions:

- `submitWords(next func() string, out chan string)` — reader
- `countWords(in chan string, out chan pair)` — worker
- `fillStats(in chan pair) counter` — consumer

Wire them together in `countDigitsInWords`.

## Test

```bash
make test concurrency/antonz/01-goroutines/05-named-goroutines
```

# 03-generator-goroutines

Source: [Gist of Go: Goroutines — Generator with goroutines](https://antonz.org/go-concurrency/goroutines/)

Implement `countDigitsInWords` for a **generator** `next func() string` that returns the next word or `""` when done.

Use a `pair` channel (word + count). Send an empty-word sentinel so the consumer knows when to stop.

## Test

```bash
make test concurrency/antonz/01-goroutines/03-generator-goroutines
```

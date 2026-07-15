# 02-result-channel

Source: [Gist of Go: Goroutines — Result channel](https://antonz.org/go-concurrency/goroutines/)

Implement `countDigitsInWords` using a **result channel**:

1. Start a goroutine that loops through words, counts digits, and sends counts to `counted`.
2. In the outer function, read from `counted` and fill `stats`.

Do **not** use wait groups.

## Test

```bash
make test concurrency/antonz/01-goroutines/02-result-channel
```

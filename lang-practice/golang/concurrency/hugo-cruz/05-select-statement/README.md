# 05-select-statement

Source: [Hugo-cruz/golang-concurrency-exercises](https://github.com/Hugo-cruz/golang-concurrency-exercises)

Implement `Multiplex(ch1, ch2 <-chan int, done <-chan struct{}) int` — return the first value received from either channel, or 0 if `done` is closed first.

No solution code in this repo.

## Test

```bash
make test concurrency/hugo-cruz/05-select-statement
```

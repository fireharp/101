# 09-deadlock-race

Source: [Hugo-cruz/golang-concurrency-exercises](https://github.com/Hugo-cruz/golang-concurrency-exercises)

Fix `BrokenBank` — it has a data race on transfers. Make `Transfer` safe without changing the test.

**Use the race detector** — the plain test may pass by luck; `-race` should report the bug until fixed:

```bash
go test -race -count=1 ./concurrency/hugo-cruz/09-deadlock-race/...
```

## Test

```bash
make test concurrency/hugo-cruz/09-deadlock-race
```

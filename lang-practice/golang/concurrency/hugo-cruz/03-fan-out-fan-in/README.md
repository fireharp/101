# 03-fan-out-fan-in

Source: [Hugo-cruz/golang-concurrency-exercises](https://github.com/Hugo-cruz/golang-concurrency-exercises)

Implement `MergeLogs` that merges multiple input log channels into a single output channel. Continue until all inputs are closed, then close the output.

Order does not matter, but all messages must appear exactly once.

## Test

```bash
make test concurrency/hugo-cruz/03-fan-out-fan-in
```

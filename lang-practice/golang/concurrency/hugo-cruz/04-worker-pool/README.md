# 04-worker-pool

Source: [Hugo-cruz/golang-concurrency-exercises](https://github.com/Hugo-cruz/golang-concurrency-exercises)

Implement `RunWorkerPool(numJobs, numWorkers int) []int`:

- `numWorkers` goroutines read jobs from a shared channel.
- Each job `j` produces result `j * 2`.
- Return all results (order does not matter).

## Test

```bash
make test concurrency/hugo-cruz/04-worker-pool
```

## Run demo

```bash
make run concurrency/hugo-cruz/04-worker-pool
```

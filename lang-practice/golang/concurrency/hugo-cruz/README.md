# Hugo-cruz Concurrency Exercises

Exercises adapted from [Hugo-cruz/golang-concurrency-exercises](https://github.com/Hugo-cruz/golang-concurrency-exercises).

Implement in **`main.go`** only. Tests are in **`main_test.go`**. No solution code is checked in.

| # | Folder | Implement | Concept |
|---|--------|-----------|---------|
| 1 | [01-basic-goroutines](01-basic-goroutines/) | `PrintOneToTen()` | Basic goroutines + WaitGroup |
| 2 | [02-basic-channels](02-basic-channels/) | `RunProducerConsumer()` | Producer-consumer channels |
| 3 | [03-fan-out-fan-in](03-fan-out-fan-in/) | `MergeLogs(...)` | Fan-out / fan-in merge |
| 4 | [04-worker-pool](04-worker-pool/) | `RunWorkerPool(...)` | Worker pool |
| 5 | [05-select-statement](05-select-statement/) | `Multiplex(...)` | Select on multiple channels |
| 6 | [06-mutex](06-mutex/) | `SafeCounter` | Mutex synchronization |
| 7 | [07-atomic](07-atomic/) | `AtomicCounter` | Atomic operations |
| 8 | [08-context-cancel](08-context-cancel/) | `RunUntilCancelled(...)` | Context cancellation |
| 9 | [09-deadlock-race](09-deadlock-race/) | Fix `BrokenBank` | Race conditions + fixes |

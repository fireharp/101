# Go Concurrency Exercises

Self-contained exercise tracks for practicing Go concurrency. Each folder is a standalone exercise you can open and start immediately.

## No spoilers policy

- **`exercise.go`** (Anton Z) or **`main.go`** (Hugo-cruz) — your implementation area only. Contains TODO stubs, not answers.
- **`support.go`** — problem helpers from the book (e.g. `countDigits`, test fixtures). Never contains the exercise solution.
- **`exercise_test.go`** / **`main_test.go`** — automated checks (separate file so tests don't leak answers).
- **No solution files in this repo.** When you want to compare, use the [Gist of Go book](https://antonz.org/go-concurrency/) or [Hugo-cruz upstream repo](https://github.com/Hugo-cruz/golang-concurrency-exercises).

## Tracks

| Track | Source | Chapters |
|-------|--------|----------|
| [antonz/](antonz/) | [Gist of Go: Concurrency](https://antonz.org/go-concurrency/) | Part 1–3 (all chapters) |
| [hugo-cruz/](hugo-cruz/) | [Hugo-cruz/golang-concurrency-exercises](https://github.com/Hugo-cruz/golang-concurrency-exercises) | 9 exercises |

## Quick start

```bash
cd lang-practice/golang

make list-concurrency
make test concurrency/antonz/01-goroutines/01-counting-digits
make test concurrency/hugo-cruz/03-fan-out-fan-in
make test concurrency/...
```

Implement the TODO sections in each exercise file. Tests should fail until your implementation is complete.

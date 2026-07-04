# Go practice

Small, isolated exercises — one folder per task.

## Layout

```
golang/
├── go.mod              # single module for all tasks
├── Makefile            # run / test / scaffold helpers
├── scripts/new-task.sh
└── tasks/
    ├── 01-hello-world/
    ├── 02-fizzbuzz/
    └── …                 # add more with make new-task
```

Each task folder is a standalone `package main` with its own tests. Shared helpers belong in `internal/` (see `internal/debug` for compile-time optional logging).

## Debug logging

Import `lang-practice/golang/internal/debug` in any task:

```go
import "lang-practice/golang/internal/debug"

debug.Println("state:", value)
debug.Printf("step %d: %v\n", i, value)
```

Logging is stripped at compile time unless you pass `-tags=debug`:

```bash
make run-debug 03-count-els-grater-prev-avg
make test-debug 03-count-els-grater-prev-avg
```

**External judges** — each task keeps a block-commented stub directly above the function you copy. Uncomment the stub, remove the `internal/debug` import, copy stub + function. Template: `internal/debug/stub_paste.go`.

## Quick start

```bash
cd lang-practice/golang

make list-tasks
make run 01-hello-world
make test
```

## Add a task

```bash
make new-task binary-search
# creates tasks/03-binary-search/ with README, main.go, main_test.go
```

## Conventions

- **Naming**: `NN-slug` (zero-padded number + kebab-case slug).
- **Tests**: table-driven tests in `*_test.go` next to the code.
- **No globals**: pass dependencies explicitly; keep `main` thin.
- **Format**: `gofmt -w .` before committing (or rely on your editor).
- **Lint** (optional): `make lint` after installing [golangci-lint](https://golangci-lint.run/).

## Useful commands

| Command | Description |
|---------|-------------|
| `make run 01-hello-world` | Run one exercise |
| `make test` | Run all tests |
| `make test 02-fizzbuzz` | Run one exercise's tests |
| `make new-task my-task` | Scaffold next numbered task |
| `go test -race ./...` | Race detector across all tasks |

[[2026-07-04 13:49:00 CEST]]
-----
PROBLEM: Need a Go practice workspace with one folder per task.
-----
WHAT WAS DONE: Bootstrapped module, Makefile, new-task scaffold script, starter tasks 01-hello-world and 02-fizzbuzz.
-----
MEMO: Run `make new-task …` to add tasks; `make run …` / `make test …` to work on one exercise.

[[2026-07-04 14:14:01 CEST]]
-----
PROBLEM: Debug build-tag helper was duplicated inside task 03.
-----
WHAT WAS DONE: Extracted shared `internal/debug` package (Println, Printf, Enabled); migrated task 03; added make run-debug / test-debug; documented in README.
-----
MEMO: Import `lang-practice/golang/internal/debug`; use `-tags=debug` or make run-debug to enable prints.

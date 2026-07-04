.PHONY: help test test-debug lint run run-debug new-task list-tasks tidy

help:
	@echo "Go practice workspace"
	@echo ""
	@echo "  make list-tasks          List available tasks"
	@echo "  make run 01-hello-world  Run one exercise"
	@echo "  make run-debug 01-hello-world  Run with debug logging (-tags=debug)"
	@echo "  make test                Run all tests"
	@echo "  make test 02-fizzbuzz    Run tests for one task"
	@echo "  make test-debug          Run all tests with debug logging enabled"
	@echo "  make test-debug 02-fizzbuzz  Run one task's tests with debug logging"
	@echo "  make lint                Run golangci-lint (if installed)"
	@echo "  make new-task fizzbuzz   Scaffold a new task folder"
	@echo "  make tidy                go mod tidy"

list-tasks:
	@ls -1 tasks

run:
	@task="$(filter-out $@,$(MAKECMDGOALS))"; \
	if [ -z "$$task" ]; then \
		echo "usage: make run <task>" >&2; \
		exit 1; \
	fi; \
	go run ./tasks/$$task

run-debug:
	@task="$(filter-out $@,$(MAKECMDGOALS))"; \
	if [ -z "$$task" ]; then \
		echo "usage: make run-debug <task>" >&2; \
		exit 1; \
	fi; \
	go run -tags=debug ./tasks/$$task

test:
	@task="$(filter-out $@,$(MAKECMDGOALS))"; \
	if [ -z "$$task" ]; then \
		go test -v -count=1 ./...; \
	else \
		go test -v -count=1 ./tasks/$$task/...; \
	fi

test-debug:
	@task="$(filter-out $@,$(MAKECMDGOALS))"; \
	if [ -z "$$task" ]; then \
		go test -v -count=1 -tags=debug ./...; \
	else \
		go test -v -count=1 -tags=debug ./tasks/$$task/...; \
	fi

lint:
	@command -v golangci-lint >/dev/null 2>&1 || (echo "install: go install github.com/golangci/golangci-lint/cmd/golangci-lint@latest" && exit 1)
	golangci-lint run ./...

new-task:
	@name="$(filter-out $@,$(MAKECMDGOALS))"; \
	if [ -z "$$name" ]; then \
		echo "usage: make new-task <name>" >&2; \
		exit 1; \
	fi; \
	./scripts/new-task.sh "$$name"

tidy:
	go mod tidy

# swallow positional args (e.g. make new-task linked-list, make run 01-hello-world)
%:
	@:

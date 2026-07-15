.PHONY: help test test-debug lint run run-debug new-task list-tasks list-concurrency tidy

help:
	@echo "Go practice workspace"
	@echo ""
	@echo "  make list-tasks          List available tasks"
	@echo "  make list-concurrency    List concurrency exercise folders"
	@echo "  make run 01-hello-world  Run one task"
	@echo "  make run concurrency/hugo-cruz/04-worker-pool  Run concurrency exercise (if main exists)"
	@echo "  make run-debug 01-hello-world  Run with debug logging (-tags=debug)"
	@echo "  make test                Run all tests"
	@echo "  make test 02-fizzbuzz    Run tests for one task"
	@echo "  make test concurrency/antonz/01-goroutines/01-counting-digits"
	@echo "  make test-debug          Run all tests with debug logging enabled"
	@echo "  make test-debug 02-fizzbuzz  Run one task's tests with debug logging"
	@echo "  make lint                Run golangci-lint (if installed)"
	@echo "  make new-task fizzbuzz   Scaffold a new task folder"
	@echo "  make tidy                go mod tidy"

list-tasks:
	@ls -1 tasks

list-concurrency:
	@find concurrency -type f \( -name exercise.go -o -name main.go \) ! -path '*/support.go' | sed 's|/exercise.go||;s|/main.go||;s|^concurrency/||' | sort -u

run:
	@task="$(filter-out $@,$(MAKECMDGOALS))"; \
	if [ -z "$$task" ]; then \
		echo "usage: make run <task-or-concurrency-path>" >&2; \
		exit 1; \
	fi; \
	case "$$task" in \
		concurrency/*) pkg="./$$task" ;; \
		*) pkg="./tasks/$$task" ;; \
	esac; \
	go run "$$pkg"

run-debug:
	@task="$(filter-out $@,$(MAKECMDGOALS))"; \
	if [ -z "$$task" ]; then \
		echo "usage: make run-debug <task-or-concurrency-path>" >&2; \
		exit 1; \
	fi; \
	case "$$task" in \
		concurrency/*) pkg="./$$task" ;; \
		*) pkg="./tasks/$$task" ;; \
	esac; \
	go run -tags=debug "$$pkg"

test:
	@task="$(filter-out $@,$(MAKECMDGOALS))"; \
	if [ -z "$$task" ]; then \
		go test -v -count=1 ./...; \
	else \
		case "$$task" in \
			concurrency/*) pkg="./$$task/..." ;; \
			*) pkg="./tasks/$$task/..." ;; \
		esac; \
		go test -v -count=1 "$$pkg"; \
	fi

test-debug:
	@task="$(filter-out $@,$(MAKECMDGOALS))"; \
	if [ -z "$$task" ]; then \
		go test -v -count=1 -tags=debug ./...; \
	else \
		case "$$task" in \
			concurrency/*) pkg="./$$task/..." ;; \
			*) pkg="./tasks/$$task/..." ;; \
		esac; \
		go test -v -count=1 -tags=debug "$$pkg"; \
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

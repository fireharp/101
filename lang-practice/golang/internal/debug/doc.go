// Package debug provides compile-time optional logging for practice tasks.
//
// By default, Println and Printf are no-ops and compile away. Enable output with:
//
//	go run -tags=debug ./tasks/01-hello-world
//	go test -tags=debug ./...
//
// For HackerRank/LeetCode, paste the stub from stub_paste.go into package main
// instead of importing this package.
package debug

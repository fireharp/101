package debug_test

import (
	"testing"

	"lang-practice/golang/internal/debug"
)

func TestPrintDoesNotPanic(t *testing.T) {
	debug.Println("line", 1, 2, 3)
	debug.Printf("formatted %s %d\n", "ok", 42)
}

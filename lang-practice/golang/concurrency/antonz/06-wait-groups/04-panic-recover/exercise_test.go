package panicrecover

import "testing"

func TestRunConcSafePanic(t *testing.T) {
	if !RunConcSafe(func() { panic("boom") }) {
		t.Fatal("expected panic detected")
	}
}

func TestRunConcSafeOK(t *testing.T) {
	if RunConcSafe(func() {}) {
		t.Fatal("unexpected panic")
	}
}

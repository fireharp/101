package nworkers

import "testing"

func TestProcess(t *testing.T) {
	words := []string{"go", "is", "fun"}
	got := process(words, 2)
	if got["go"] != 2 || got["is"] != 2 || got["fun"] != 3 {
		t.Fatalf("unexpected map: %v", got)
	}
}

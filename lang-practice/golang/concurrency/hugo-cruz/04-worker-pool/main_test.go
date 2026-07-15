package workerpool

import "testing"

func TestRunWorkerPool(t *testing.T) {
	results := RunWorkerPool(10, 3)
	if len(results) != 10 {
		t.Fatalf("got %d results, want 10", len(results))
	}
	seen := make(map[int]bool)
	for _, r := range results {
		if r%2 != 0 {
			t.Fatalf("expected even result, got %d", r)
		}
		seen[r/2] = true
	}
	if len(seen) != 10 {
		t.Fatalf("missing job results: %v", seen)
	}
}

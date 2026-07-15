package guessaverage

import "testing"

func TestAverage(t *testing.T) {
	vals := []int{2, 4, 6, 8}
	got := Average(2, vals)
	if got != 5 {
		t.Fatalf("got %v, want 5", got)
	}
}

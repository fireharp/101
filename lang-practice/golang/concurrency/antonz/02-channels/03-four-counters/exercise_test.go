package fourcounters

import "testing"

func TestSumFromFourCounters(t *testing.T) {
	const n = 1000
	got := sumFromFourCounters(n)
	want := 4 * n
	if got != want {
		t.Fatalf("got %d, want %d", got, want)
	}
}

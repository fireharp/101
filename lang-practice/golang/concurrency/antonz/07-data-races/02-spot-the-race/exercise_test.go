package spottherace

import "testing"

func TestIncrementTotal(t *testing.T) {
	got := incrementTotal(1000, 5)
	want := 5000
	if got != want {
		t.Fatalf("got %d, want %d", got, want)
	}
}

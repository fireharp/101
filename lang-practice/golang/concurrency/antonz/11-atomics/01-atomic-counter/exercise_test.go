package atomiccounter

import "testing"

func TestTotal(t *testing.T) {
	if got := totalAfterIncrements(10000, 5); got != 50000 {
		t.Fatalf("got %d", got)
	}
}

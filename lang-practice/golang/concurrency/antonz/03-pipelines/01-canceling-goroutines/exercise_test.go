package cancelinggoroutines

import "testing"

func TestGenerateCancel(t *testing.T) {
	out := make(chan int, 10)
	cancel := make(chan struct{})
	close(cancel)

	go generate(out, cancel, 100)
	count := 0
	for range out {
		count++
	}
	if count >= 100 {
		t.Fatalf("expected early cancel, got %d values", count)
	}
}

package selectstatement

import "testing"

func TestMultiplexCh1(t *testing.T) {
	ch1 := make(chan int, 1)
	ch1 <- 42
	ch2 := make(chan int)
	close(ch2)
	done := make(chan struct{})
	if got := Multiplex(ch1, ch2, done); got != 42 {
		t.Fatalf("got %d, want 42", got)
	}
}

func TestMultiplexDone(t *testing.T) {
	ch1 := make(chan int)
	ch2 := make(chan int)
	done := make(chan struct{})
	close(done)
	if got := Multiplex(ch1, ch2, done); got != 0 {
		t.Fatalf("got %d, want 0", got)
	}
}

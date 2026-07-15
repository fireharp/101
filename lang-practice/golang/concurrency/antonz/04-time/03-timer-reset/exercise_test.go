package timerreset

import (
	"testing"
	"time"
)

func TestConsumerReceives(t *testing.T) {
	cancel := make(chan struct{})
	defer close(cancel)
	tokens := make(chan token, 1)
	tokens <- token{}
	close(tokens)
	n := consumer(cancel, tokens, time.Hour)
	if n < 1 {
		t.Fatalf("expected at least 1 token processed, got %d", n)
	}
}

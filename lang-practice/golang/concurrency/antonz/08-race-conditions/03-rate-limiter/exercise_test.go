package ratelimiter

import "testing"

func TestLimiter(t *testing.T) {
	l := NewLimiter(10)
	allowed := 0
	for i := 0; i < 20; i++ {
		if l.Allow() {
			allowed++
		}
	}
	if allowed == 0 || allowed > 10 {
		t.Fatalf("allowed %d", allowed)
	}
}

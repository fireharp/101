package tryacquire

import "testing"

func TestTryAcquire(t *testing.T) {
	s := NewSemaphore(1)
	if !s.TryAcquire() {
		t.Fatal("first should succeed")
	}
	if s.TryAcquire() {
		t.Fatal("second should fail")
	}
	s.Release()
}

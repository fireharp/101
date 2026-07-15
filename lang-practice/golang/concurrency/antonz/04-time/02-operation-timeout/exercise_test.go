package operationtimeout

import (
	"testing"
	"time"
)

func TestWithTimeoutSuccess(t *testing.T) {
	v, err := withTimeout(50*time.Millisecond, func() int { return 42 })
	if err != nil || v != 42 {
		t.Fatalf("got %d, %v", v, err)
	}
}

func TestWithTimeoutFail(t *testing.T) {
	_, err := withTimeout(10*time.Millisecond, func() int {
		time.Sleep(50 * time.Millisecond)
		return 0
	})
	if err != ErrTimeout {
		t.Fatalf("expected timeout, got %v", err)
	}
}

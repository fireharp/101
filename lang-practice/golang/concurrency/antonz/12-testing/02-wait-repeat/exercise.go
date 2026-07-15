package waitrepeat

import (
	"testing"
	"time"
)

// Eventually calls fn until it succeeds or timeout elapses.
func Eventually(t *testing.T, timeout time.Duration, fn func() error) {
	// TODO
	_ = t
	_ = timeout
	_ = fn
	t.Fatal("not implemented")
}

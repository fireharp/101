package operationtimeout

import (
	"errors"
	"time"
)

var ErrTimeout = errors.New("timeout")

// withTimeout runs fn in a goroutine and returns its result or ErrTimeout.
func withTimeout(timeout time.Duration, fn func() int) (int, error) {
	// TODO: done channel + select with time.After.
	_ = timeout
	_ = fn
	return 0, ErrTimeout
}

package throttlebackpressure

import "errors"

var ErrBusy = errors.New("busy")

// throttle limits concurrent fn executions to n. handle returns ErrBusy when saturated.
func throttle(n int, fn func()) (handle func() error, wait func()) {
	// TODO: semaphore channel; select with default for backpressure.
	_ = n
	_ = fn
	return func() error { return ErrBusy }, func() {}
}

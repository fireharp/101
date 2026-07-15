package atomicex

// AtomicCounter uses atomic operations for concurrent increments.
type AtomicCounter struct {
	// TODO: use atomic.Int64 or similar
}

func (c *AtomicCounter) Increment() {}
func (c *AtomicCounter) Value() int64 { return 0 }

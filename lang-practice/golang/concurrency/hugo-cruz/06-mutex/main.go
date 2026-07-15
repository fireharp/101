package mutex

// SafeCounter is safe for concurrent increments.
type SafeCounter struct {
	// TODO: add fields
}

func (c *SafeCounter) Increment() {}
func (c *SafeCounter) Value() int { return 0 }

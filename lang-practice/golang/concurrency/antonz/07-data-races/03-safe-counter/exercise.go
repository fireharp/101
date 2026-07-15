package safecounter

// Counter is safe for concurrent use.
type Counter struct {
	// TODO: add mutex and value
}

func (c *Counter) Inc() {}
func (c *Counter) Value() int { return 0 }

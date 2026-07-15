package implementingsemaphore

// Semaphore limits concurrent access to n goroutines.
type Semaphore struct {
	// TODO: use a channel
}

func NewSemaphore(n int) *Semaphore {
	_ = n
	return &Semaphore{}
}

func (s *Semaphore) Acquire() {}
func (s *Semaphore) Release() {}

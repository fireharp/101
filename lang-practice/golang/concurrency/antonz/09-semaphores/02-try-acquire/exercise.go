package tryacquire

// Semaphore with blocking Acquire and non-blocking TryAcquire.
type Semaphore struct {
	// TODO
}

func NewSemaphore(n int) *Semaphore { return &Semaphore{} }
func (s *Semaphore) Acquire()        {}
func (s *Semaphore) TryAcquire() bool { return false }
func (s *Semaphore) Release()        {}

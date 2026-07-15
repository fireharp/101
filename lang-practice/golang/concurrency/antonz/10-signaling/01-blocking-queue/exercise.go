package blockingqueue

// Queue is a bounded blocking queue.
type Queue struct {
	// TODO
}

func NewQueue(capacity int) *Queue { return &Queue{} }

func (q *Queue) Put(item int) {}
func (q *Queue) Get() int     { return 0 }

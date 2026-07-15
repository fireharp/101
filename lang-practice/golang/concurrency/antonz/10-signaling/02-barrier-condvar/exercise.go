package barriercondvar

// CondBarrier blocks until n goroutines call Touch.
type CondBarrier struct {
	// TODO: use sync.Cond
}

func NewCondBarrier(n int) *CondBarrier { return &CondBarrier{} }

func (b *CondBarrier) Touch() {}

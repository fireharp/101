package barrier

// Barrier blocks goroutines until n have called Touch.
type Barrier struct {
	// TODO
}

func NewBarrier(n int) *Barrier { return &Barrier{} }

func (b *Barrier) Touch() {}

package ratelimiter

// Limiter allows at most rate events per second.
type Limiter struct {
	// TODO
}

func NewLimiter(rate int) *Limiter { return &Limiter{} }

func (l *Limiter) Allow() bool {
	// TODO
	return false
}

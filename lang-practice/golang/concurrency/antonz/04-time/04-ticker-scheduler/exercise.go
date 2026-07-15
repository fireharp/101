package tickerscheduler

import "time"

// schedule calls fn on each tick interval, exactly n times, then returns n.
func schedule(interval time.Duration, n int, fn func(time.Time)) int {
	// TODO: use time.NewTicker
	_ = interval
	_ = n
	_ = fn
	return 0
}

package timerreset

import "time"

// consumer reads tokens from in; logs warning if none arrive within timeout.
// Must reuse a single timer (no time.After in the loop).
func consumer(cancel <-chan struct{}, in <-chan token, timeout time.Duration) int {
	// TODO: NewTimer + Reset pattern
	_ = cancel
	_ = in
	_ = timeout
	return 0
}

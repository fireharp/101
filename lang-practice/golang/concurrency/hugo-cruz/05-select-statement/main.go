package selectstatement

// Multiplex returns the first value from ch1 or ch2, or 0 if done is closed first.
func Multiplex(ch1, ch2 <-chan int, done <-chan struct{}) int {
	// TODO: use select
	_ = ch1
	_ = ch2
	_ = done
	return 0
}

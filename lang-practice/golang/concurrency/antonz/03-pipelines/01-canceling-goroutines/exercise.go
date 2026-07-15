package cancelinggoroutines

// generate sends integers 0..n-1 to out unless cancel is closed first.
func generate(out chan<- int, cancel <-chan struct{}, n int) {
	// TODO: select on cancel while sending.
	close(out)
	_ = cancel
	_ = n
}

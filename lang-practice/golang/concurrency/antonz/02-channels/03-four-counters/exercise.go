package fourcounters

// sumFromFourCounters returns the total after four goroutines each add n increments.
func sumFromFourCounters(n int) int {
	// TODO: use a channel-based approach (no mutex) so four goroutines increment safely.
	done := make(chan int, 4)

	for i := 0; i < 4; i++ {
		go func() {
			done <- n
		}()
	}

	sum := 0
	for i := 0; i < 4; i++ {
		sum += <-done
	}
	return sum
}

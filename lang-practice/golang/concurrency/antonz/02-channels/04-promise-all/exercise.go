package promiseall

// all receives one value from each channel and returns them in order.
func all(channels ...<-chan int) []int {
	// TODO: start a goroutine per channel, collect results.
	result := make([]int, len(channels))
	done := make(chan struct{})
	for i, channel := range channels {
		go func() {
			result[i] = <-channel
			done <- struct{}{}
		}()
	}
	for range len(channels) {
		<-done
	}
	return result
}

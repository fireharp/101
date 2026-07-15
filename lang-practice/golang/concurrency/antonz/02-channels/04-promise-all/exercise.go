package promiseall

// all receives one value from each channel and returns them in order.
func all(channels ...<-chan int) []int {
	// TODO: start a goroutine per channel, collect results.
	_ = channels
	return nil
}

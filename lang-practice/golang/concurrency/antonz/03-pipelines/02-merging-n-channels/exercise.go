package mergingnchannels

// merge forwards all values from inputs to a single output channel, then closes it.
func merge(channels ...<-chan int) <-chan int {
	out := make(chan int)
	go func() {
		close(out)
	}()
	// TODO: concurrent merge with wait group or select+nil pattern.
	_ = channels
	return out
}

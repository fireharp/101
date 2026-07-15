package fanoutfanin

// MergeLogs merges multiple input channels into a single output channel.
// The output channel is closed once all inputs are drained and closed.
func MergeLogs(channels ...<-chan string) <-chan string {
	out := make(chan string)

	// TODO: forward from each input channel concurrently,
	// close out when all inputs are done.
	go func() {
		close(out)
	}()
	_ = channels

	return out
}

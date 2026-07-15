package iterateandclose

// drain reads all values from in until the channel is closed.
func drain(in <-chan string) []string {
	// TODO: use range over channel
	_ = in
	return nil
}

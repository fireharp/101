package iterateandclose

// drain reads all values from in until the channel is closed.
func drain(in <-chan string) []string {
	// TODO: use range over channel
	result := make([]string, 0)
	for v := range in {
		result = append(result, v)
	}
	return result
}

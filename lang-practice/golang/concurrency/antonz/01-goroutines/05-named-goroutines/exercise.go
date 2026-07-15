package namedgoroutines

// countDigitsInWords counts the number of digits in words,
// fetching the next word with next().
func countDigitsInWords(next func() string) counter {
	// TODO: create channels, start submitWords and countWords goroutines,
	// return fillStats(counted).
	_ = next
	return counter{}
}

// submitWords sends words to be counted.
func submitWords(next func() string, out chan string) {
	_ = next
	_ = out
}

// countWords counts digits in words.
func countWords(in chan string, out chan pair) {
	_ = in
	_ = out
}

// fillStats prepares the final statistics.
func fillStats(in chan pair) counter {
	_ = in
	return counter{}
}

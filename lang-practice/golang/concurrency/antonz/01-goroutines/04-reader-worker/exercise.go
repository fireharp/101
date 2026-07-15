package readerworker

// countDigitsInWords counts the number of digits in words,
// fetching the next word with next().
func countDigitsInWords(next func() string) counter {
	pending := make(chan string)
	counted := make(chan pair)

	// sends words to be counted
	go func() {
		// Fetch words from the generator
		// and send them to the pending channel.
		_ = next
	}()

	// counts digits in words
	go func() {
		// Read the words from the pending channel,
		// count the number of digits in each word,
		// and send the results to the counted channel.
		_ = pending
	}()

	// Read values from the counted channel and fill stats.
	stats := counter{}
	_ = counted

	return stats
}

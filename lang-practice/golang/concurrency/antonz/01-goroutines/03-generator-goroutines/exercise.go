package generatorgoroutines

// countDigitsInWords counts the number of digits in words,
// fetching the next word with next().
func countDigitsInWords(next func() string) counter {
	counted := make(chan pair)

	go func() {
		// Fetch words from the generator,
		// count the number of digits in each,
		// and write it to the counted channel.
		_ = next
	}()

	// Read values from the counted channel and fill stats.
	stats := counter{}
	_ = counted

	return stats
}

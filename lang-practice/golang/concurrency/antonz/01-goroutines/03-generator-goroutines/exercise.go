package generatorgoroutines

// countDigitsInWords counts the number of digits in words,
// fetching the next word with next().
func countDigitsInWords(next func() string) counter {
	counted := make(chan pair)

	go func() {
		defer close(counted)
		// Fetch words from the generator,
		// count the number of digits in each,
		// and write it to the counted channel.
		for word := next(); word != ""; word = next() {
			counted <- pair{word: word, count: countDigits(word)}
		}
	}()

	// Read values from the counted channel and fill stats.
	stats := counter{}
	for pair := range counted {
		stats[pair.word] = pair.count
	}

	return stats
}

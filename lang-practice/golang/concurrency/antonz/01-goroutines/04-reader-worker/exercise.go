package readerworker

// countDigitsInWords counts the number of digits in words,
// fetching the next word with next().
func countDigitsInWords(next func() string) counter {
	pending := make(chan string)
	counted := make(chan pair)

	// sends words to be counted
	go func() {
		defer close(pending)
		for word := next(); word != ""; word = next() {
			pending <- word
		}
	}()

	// counts digits in words
	go func() {
		defer close(counted)
		// Read the words from the pending channel,
		// count the number of digits in each word,
		// and send the results to the counted channel.
		for word := range pending {
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

package namedgoroutines

// countDigitsInWords counts the number of digits in words,
// fetching the next word with next().
func countDigitsInWords(next func() string) counter {
	// TODO: create channels, start submitWords and countWords goroutines,
	// return fillStats(counted).
	pending := make(chan string)
	go submitWords(next, pending)

	counted := make(chan pair)
	go countWords(pending, counted)

	return fillStats(counted)
}

// submitWords sends words to be counted.
func submitWords(next func() string, out chan string) {
	defer close(out)
	for word := next(); word != ""; word = next() {
		out <- word
	}
}

// countWords counts digits in words.
func countWords(in chan string, out chan pair) {
	defer close(out)
	for word := range in {
		out <- pair{word: word, count: countDigits(word)}
	}
}

// fillStats prepares the final statistics.
func fillStats(in chan pair) counter {
	stats := counter{}
	for pair := range in {
		stats[pair.word] = pair.count
	}
	return stats
}

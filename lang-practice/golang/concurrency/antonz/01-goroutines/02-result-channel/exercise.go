package resultchannel

import (
	"strings"
	"unicode"
)

// countDigitsInWords counts the number of digits in the words of a phrase.
func countDigitsInWords(phrase string) counter {
	words := strings.Fields(phrase)
	counted := make(chan counter)

	go func() {
		defer close(counted)
		for _, word := range words {
			counted <- counter{word: countDigitsInWord(word)}
		}
	}()

	// Read values from the counted channel and fill stats.
	stats := counter{}
	for count := range counted {
		for word, count := range count {
			stats[word] = count
		}
	}

	return stats
}

func countDigitsInWord(word string) int {
	count := 0
	for _, char := range word {
		if unicode.IsDigit(char) {
			count++
		}
	}
	return count
}

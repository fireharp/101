package resultchannel

import "strings"

// countDigitsInWords counts the number of digits in the words of a phrase.
func countDigitsInWords(phrase string) counter {
	words := strings.Fields(phrase)
	counted := make(chan int)

	go func() {
		// Loop through the words,
		// count the number of digits in each,
		// and write it to the counted channel.
		_ = words
	}()

	// Read values from the counted channel and fill stats.
	stats := counter{}
	_ = counted

	return stats
}

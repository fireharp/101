package countingdigits

import (
	"fmt"
	"strings"
	"sync"
	"time"
	"unicode"
)

// countDigitsInWords counts the number of digits in the words of a phrase.
func countDigitsInWords(phrase string) counter {
	var wg sync.WaitGroup
	start := time.Now()
	syncStats := new(sync.Map)
	words := strings.Fields(phrase)

	for _, word := range words {
		wg.Go(func() {
			count := countDigitsInWord(word)
			syncStats.Store(word, count)
		})
	}

	wg.Wait()

	fmt.Println("Time taken:", time.Since(start))
	printStats(asStats(syncStats))
	return asStats(syncStats)
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

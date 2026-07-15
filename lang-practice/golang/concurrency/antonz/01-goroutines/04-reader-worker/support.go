package readerworker

import (
	"fmt"
	"strings"
	"sync"
	"unicode"
)

type counter map[string]int

type pair struct {
	word  string
	count int
}

func countDigits(str string) int {
	count := 0
	for _, char := range str {
		if unicode.IsDigit(char) {
			count++
		}
	}
	return count
}

func asStats(m *sync.Map) counter {
	stats := counter{}
	m.Range(func(key, value any) bool {
		stats[key.(string)] = value.(int)
		return true
	})
	return stats
}

func wordGenerator(phrase string) func() string {
	words := strings.Fields(phrase)
	i := 0
	return func() string {
		if i >= len(words) {
			return ""
		}
		word := words[i]
		i++
		return word
	}
}

func printStats(c counter) {
	for word, count := range c {
		fmt.Printf("%s: %d\n", word, count)
	}
}

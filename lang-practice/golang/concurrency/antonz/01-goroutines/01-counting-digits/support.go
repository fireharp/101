package countingdigits

import (
	"fmt"
	"sync"
	"unicode"
)

type counter map[string]int

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

func printStats(c counter) {
	for word, count := range c {
		fmt.Printf("%s: %d\n", word, count)
	}
}

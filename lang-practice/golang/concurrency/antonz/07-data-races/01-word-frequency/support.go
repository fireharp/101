package wordfrequency

import (
	"math/rand"
)

func randomWord(n int) string {
	const vowels = "eaiou"
	const consonants = "rtnslcdpm"
	chars := make([]byte, n)
	for i := 0; i < n; i += 2 {
		chars[i] = consonants[rand.Intn(len(consonants))]
	}
	for i := 1; i < n; i += 2 {
		chars[i] = vowels[rand.Intn(len(vowels))]
	}
	return string(chars)
}

func generate(n int) <-chan string {
	out := make(chan string)
	go func() {
		defer close(out)
		for i := 0; i < n; i++ {
			out <- randomWord(3)
		}
	}()
	return out
}

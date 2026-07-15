package nworkers

import "sync"

// process counts word lengths using n concurrent workers.
func process(words []string, n int) map[string]int {
	result := new(sync.Map)

	sema := make(chan int, n)
	for i := 0; i < n; i++ {
		sema <- i + 1
	}

	for _, word := range words {
		<-sema
		go job(sema, word, result)
	}

	for i := 0; i < n; i++ {
		<-sema
	}

	resultMap := map[string]int{}
	result.Range(func(key, value any) bool {
		resultMap[key.(string)] = value.(int)
		return true
	})
	return resultMap
}

func job(sema chan int, word string, result *sync.Map) {
	result.Store(word, wordLen(word))
	sema <- 1
}

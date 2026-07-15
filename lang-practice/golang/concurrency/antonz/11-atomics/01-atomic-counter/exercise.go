package atomiccounter

import "sync"

// totalAfterIncrements returns total after g goroutines each increment n times.
func totalAfterIncrements(n, g int) int {
	total := 0
	var wg sync.WaitGroup
	for i := 0; i < g; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := 0; j < n; j++ {
				total++
			}
		}()
	}
	wg.Wait()
	return total
}

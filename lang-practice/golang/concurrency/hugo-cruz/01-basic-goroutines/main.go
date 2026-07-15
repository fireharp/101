package basicgoroutines

import "sync"

// PrintOneToTen launches goroutines to process values 1-10 concurrently
// and returns the collected values in ascending order.
func PrintOneToTen() []int {
	var wg sync.WaitGroup
	results := make([]int, 0, 10)

	// TODO: spawn one goroutine per value 1..10,
	// collect results safely, wait with wg, return sorted slice.
	_ = wg
	_ = results

	return results
}

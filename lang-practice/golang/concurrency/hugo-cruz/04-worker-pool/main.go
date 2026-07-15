package workerpool

import "fmt"

// RunWorkerPool processes numJobs using numWorkers concurrent workers.
// Each job j produces result j*2. Returns all results (order unspecified).
func RunWorkerPool(numJobs, numWorkers int) []int {
	// TODO: implement worker pool with jobs and results channels.
	_ = numJobs
	_ = numWorkers
	return nil
}

func main() {
	results := RunWorkerPool(50, 3)
	for _, r := range results {
		fmt.Println("result:", r)
	}
}

package cancelableworker

import "context"

// runWorkers starts n workers processing jobs until ctx is canceled.
func runWorkers(ctx context.Context, n int, jobs <-chan int, results chan<- int) {
	// TODO
	_ = ctx
	_ = n
	_ = jobs
	_ = results
}

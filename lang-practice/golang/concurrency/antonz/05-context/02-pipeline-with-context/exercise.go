package pipelinewithcontext

import "context"

// countStage reads words from in, sends digit counts to out until ctx canceled.
func countStage(ctx context.Context, in <-chan string, out chan<- int) {
	// TODO
	for range in {
		out <- 0
	}
	_ = ctx
}

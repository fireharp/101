package cancelableworker

import (
	"context"
	"testing"
)

func TestRunWorkersCancel(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	jobs := make(chan int)
	results := make(chan int, 10)
	go runWorkers(ctx, 2, jobs, results)
	cancel()
	close(jobs)
}

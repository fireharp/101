package waitingforworker

import (
	"sync/atomic"
	"testing"
)

func TestStartWorkers(t *testing.T) {
	var count atomic.Int32
	startWorkers(3, func(i int) { count.Add(1) })
	if count.Load() != 3 {
		t.Fatalf("got %d", count.Load())
	}
}

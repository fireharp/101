package runtimesimulator

import (
	"sync/atomic"
	"testing"
)

func TestSimulate(t *testing.T) {
	var count atomic.Int32
	tasks := make([]func(), 10)
	for i := range tasks {
		tasks[i] = func() { count.Add(1) }
	}
	Simulate(2, tasks)
	if count.Load() != 10 {
		t.Fatalf("got %d", count.Load())
	}
}

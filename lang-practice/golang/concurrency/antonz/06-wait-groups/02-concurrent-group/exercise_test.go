package concurrentgroup

import (
	"sync/atomic"
	"testing"
)

func TestRunConc(t *testing.T) {
	var n atomic.Int32
	RunConc(
		func() { n.Add(1) },
		func() { n.Add(1) },
	)
	if n.Load() != 2 {
		t.Fatalf("got %d", n.Load())
	}
}

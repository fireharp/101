package barrier

import (
	"sync"
	"sync/atomic"
	"testing"
)

func TestBarrier(t *testing.T) {
	b := NewBarrier(3)
	var reached atomic.Int32
	var wg sync.WaitGroup
	for i := 0; i < 3; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			b.Touch()
			reached.Add(1)
		}()
	}
	wg.Wait()
	if reached.Load() != 3 {
		t.Fatalf("got %d", reached.Load())
	}
}

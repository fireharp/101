package atomicex

import (
	"sync"
	"testing"
)

func TestAtomicCounter(t *testing.T) {
	var c AtomicCounter
	var wg sync.WaitGroup
	for i := 0; i < 100; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			c.Increment()
		}()
	}
	wg.Wait()
	if c.Value() != 100 {
		t.Fatalf("got %d, want 100", c.Value())
	}
}

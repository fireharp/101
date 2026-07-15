package mutex

import (
	"sync"
	"testing"
)

func TestSafeCounter(t *testing.T) {
	var c SafeCounter
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

package concurrentmaprc

import (
	"sync"
	"testing"
)

func TestLazyMap(t *testing.T) {
	var lm LazyMap
	var wg sync.WaitGroup
	for i := 0; i < 50; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			v := lm.GetOrCreate("x", func() int { return 42 })
			if v != 42 {
				t.Fatalf("got %d", v)
			}
		}()
	}
	wg.Wait()
}

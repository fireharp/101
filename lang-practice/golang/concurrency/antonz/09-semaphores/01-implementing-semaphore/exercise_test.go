package implementingsemaphore

import (
	"sync"
	"testing"
	"time"
)

func TestSemaphoreLimitsConcurrency(t *testing.T) {
	sem := NewSemaphore(2)
	var current, maxConcurrent int
	var mu sync.Mutex
	var wg sync.WaitGroup
	for i := 0; i < 6; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			sem.Acquire()
			defer sem.Release()
			mu.Lock()
			current++
			if current > maxConcurrent {
				maxConcurrent = current
			}
			mu.Unlock()
			time.Sleep(10 * time.Millisecond)
			mu.Lock()
			current--
			mu.Unlock()
		}()
	}
	wg.Wait()
	if maxConcurrent > 2 {
		t.Fatalf("max concurrent %d, want <= 2", maxConcurrent)
	}
}

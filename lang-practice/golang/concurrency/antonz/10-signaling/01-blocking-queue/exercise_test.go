package blockingqueue

import (
	"sync"
	"testing"
)

func TestQueue(t *testing.T) {
	q := NewQueue(2)
	q.Put(1)
	q.Put(2)
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		if q.Get() != 1 {
			t.Fatal("expected 1")
		}
	}()
	wg.Wait()
}

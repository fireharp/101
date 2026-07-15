package lockfreestack

import (
	"sync"
	"testing"
)

func TestStack(t *testing.T) {
	var s Stack
	var wg sync.WaitGroup
	for i := 0; i < 100; i++ {
		wg.Add(1)
		go func(v int) {
			defer wg.Done()
			s.Push(v)
		}(i)
	}
	wg.Wait()
	count := 0
	for {
		if _, ok := s.Pop(); !ok {
			break
		}
		count++
	}
	if count != 100 {
		t.Fatalf("got %d pops", count)
	}
}

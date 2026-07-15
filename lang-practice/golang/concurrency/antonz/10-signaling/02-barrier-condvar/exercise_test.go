package barriercondvar

import (
	"sync"
	"testing"
)

func TestCondBarrier(t *testing.T) {
	b := NewCondBarrier(2)
	var wg sync.WaitGroup
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			b.Touch()
		}()
	}
	wg.Wait()
}

package counterrwmutex

import (
	"sync"
	"testing"
)

func TestFreqMap(t *testing.T) {
	var f FreqMap
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		f.Inc("go")
	}()
	wg.Add(1)
	go func() {
		defer wg.Done()
		_ = f.Get("go")
	}()
	wg.Wait()
	if f.Get("go") != 1 {
		t.Fatalf("got %d", f.Get("go"))
	}
}

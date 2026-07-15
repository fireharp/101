package deadlockrace

import (
	"sync"
	"testing"
)

func TestTransferConcurrent(t *testing.T) {
	a := NewBrokenBank(1000)
	b := NewBrokenBank(0)
	var wg sync.WaitGroup
	for i := 0; i < 50; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			a.Transfer(b, 10)
		}()
	}
	wg.Wait()
	if b.Balance() != 500 {
		t.Fatalf("expected b=500, got a=%d b=%d", a.Balance(), b.Balance())
	}
	if a.Balance()+b.Balance() != 1000 {
		t.Fatalf("money lost: a=%d b=%d", a.Balance(), b.Balance())
	}
}

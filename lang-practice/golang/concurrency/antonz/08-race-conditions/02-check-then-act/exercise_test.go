package checkthenact

import (
	"sync"
	"testing"
)

func TestTransfer(t *testing.T) {
	a := &Account{}
	a.Deposit(100)
	var wg sync.WaitGroup
	for i := 0; i < 10; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			Transfer(a, &Account{}, 10)
		}()
	}
	wg.Wait()
}

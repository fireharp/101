package waituntildone

import (
	"sync/atomic"
	"testing"
)

func TestWaitUntilDone(t *testing.T) {
	var done atomic.Bool
	waitUntilDone(func() { done.Store(true) })
	if !done.Load() {
		t.Fatal("not done")
	}
}

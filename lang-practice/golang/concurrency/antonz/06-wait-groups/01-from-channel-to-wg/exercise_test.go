package fromchanneltowg

import (
	"sync/atomic"
	"testing"
	"time"
)

func TestRunAndWait(t *testing.T) {
	var done atomic.Bool
	runAndWait(func() {
		time.Sleep(10 * time.Millisecond)
		done.Store(true)
	})
	if !done.Load() {
		t.Fatal("fn did not complete")
	}
}

package rendezvous

import (
	"sync/atomic"
	"testing"
)

func TestRendezvous(t *testing.T) {
	r := NewRendezvous()
	var a, b atomic.Bool
	go func() {
		r.Meet()
		a.Store(b.Load())
	}()
	r.Meet()
	b.Store(true)
	if !a.Load() {
		t.Fatal("rendezvous failed")
	}
}

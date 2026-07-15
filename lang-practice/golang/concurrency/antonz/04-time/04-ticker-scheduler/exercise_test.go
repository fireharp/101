package tickerscheduler

import (
	"sync/atomic"
	"testing"
	"time"
)

func TestSchedule(t *testing.T) {
	var count atomic.Int32
	n := schedule(10*time.Millisecond, 3, func(time.Time) {
		count.Add(1)
	})
	if n != 3 || count.Load() != 3 {
		t.Fatalf("n=%d count=%d", n, count.Load())
	}
}

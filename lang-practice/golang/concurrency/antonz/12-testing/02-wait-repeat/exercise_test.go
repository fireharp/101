package waitrepeat

import (
	"errors"
	"testing"
	"time"
)

func TestEventually(t *testing.T) {
	var n int
	Eventually(t, 100*time.Millisecond, func() error {
		n++
		if n < 3 {
			return errors.New("not yet")
		}
		return nil
	})
}

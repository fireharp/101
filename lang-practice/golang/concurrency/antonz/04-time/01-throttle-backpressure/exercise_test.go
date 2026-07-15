package throttlebackpressure

import "testing"

func TestThrottleBackpressure(t *testing.T) {
	started := make(chan struct{}, 1)
	handle, wait := throttle(1, func() {
		<-started
	})
	if err := handle(); err != nil {
		t.Fatal(err)
	}
	if err := handle(); err != ErrBusy {
		t.Fatalf("expected busy, got %v", err)
	}
	close(started)
	wait()
}

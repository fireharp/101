package comparingblocks

import "testing"

func TestSendAllUnbuffered(t *testing.T) {
	ch := make(chan int)
	go func() {
		for range 3 {
			<-ch
		}
	}()
	blocked := sendAll(ch, []int{1, 2, 3})
	if blocked < 0 {
		t.Fatalf("blocked %d", blocked)
	}
}

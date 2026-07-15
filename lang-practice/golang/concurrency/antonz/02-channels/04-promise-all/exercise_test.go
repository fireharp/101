package promiseall

import (
	"reflect"
	"testing"
)

func TestAll(t *testing.T) {
	ch1 := make(chan int, 1)
	ch1 <- 1
	close(ch1)
	ch2 := make(chan int, 1)
	ch2 <- 2
	close(ch2)

	got := all(ch1, ch2)
	want := []int{1, 2}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
}

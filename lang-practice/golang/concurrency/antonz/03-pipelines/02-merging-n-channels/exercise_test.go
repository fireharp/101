package mergingnchannels

import (
	"sort"
	"testing"
)

func TestMerge(t *testing.T) {
	ch1 := make(chan int, 2)
	ch1 <- 1
	ch1 <- 2
	close(ch1)
	ch2 := make(chan int, 1)
	ch2 <- 3
	close(ch2)

	out := merge(ch1, ch2)
	var got []int
	for v := range out {
		got = append(got, v)
	}
	sort.Ints(got)
	want := []int{1, 2, 3}
	if len(got) != len(want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("got %v, want %v", got, want)
		}
	}
}

package basicchannels

import (
	"reflect"
	"testing"
)

func TestRunProducerConsumer(t *testing.T) {
	got := RunProducerConsumer()
	want := []int{1, 2, 3, 4, 5, 6, 7, 8, 9, 10}

	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
}

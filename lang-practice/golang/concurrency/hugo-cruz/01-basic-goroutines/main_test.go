package basicgoroutines

import (
	"reflect"
	"testing"
)

func TestPrintOneToTen(t *testing.T) {
	got := PrintOneToTen()
	want := []int{1, 2, 3, 4, 5, 6, 7, 8, 9, 10}

	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
}

package countingdigits

import (
	"reflect"
	"testing"
)

func TestCountDigitsInWords(t *testing.T) {
	stats := countDigitsInWords("0ne 1wo thr33 4068")

	want := counter{
		"0ne":   1,
		"1wo":   1,
		"thr33": 2,
		"4068":  4,
	}

	if !reflect.DeepEqual(stats, want) {
		t.Fatalf("got %v, want %v", stats, want)
	}
}

func TestCountDigitsInWordsEmpty(t *testing.T) {
	stats := countDigitsInWords("")
	if len(stats) != 0 {
		t.Fatalf("expected empty stats, got %v", stats)
	}
}

func TestCountDigitsInWordsNoDigits(t *testing.T) {
	stats := countDigitsInWords("hello world")
	want := counter{"hello": 0, "world": 0}
	if !reflect.DeepEqual(stats, want) {
		t.Fatalf("got %v, want %v", stats, want)
	}
}

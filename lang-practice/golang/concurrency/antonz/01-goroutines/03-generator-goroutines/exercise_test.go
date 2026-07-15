package generatorgoroutines

import (
	"reflect"
	"testing"
)

func TestCountDigitsInWords(t *testing.T) {
	next := wordGenerator("0ne 1wo thr33 4068")
	stats := countDigitsInWords(next)

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
	next := wordGenerator("")
	stats := countDigitsInWords(next)
	if len(stats) != 0 {
		t.Fatalf("expected empty stats, got %v", stats)
	}
}

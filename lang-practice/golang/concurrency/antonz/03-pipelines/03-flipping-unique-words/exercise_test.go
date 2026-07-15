package flippinguniquewords

import (
	"reflect"
	"testing"
)

func wordGen(words ...string) func() string {
	i := 0
	return func() string {
		if i >= len(words) {
			return ""
		}
		w := words[i]
		i++
		return w
	}
}

func TestFlipUnique(t *testing.T) {
	next := wordGen("go", "go", "si")
	got := flipUnique(next)
	want := []string{"og", "is"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
}

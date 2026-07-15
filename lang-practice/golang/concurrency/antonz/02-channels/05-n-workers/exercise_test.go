package nworkers

import (
	"reflect"
	"testing"
)

func TestProcess(t *testing.T) {
	tests := []struct {
		name  string
		words []string
		n     int
		want  map[string]int
	}{
		{
			name:  "two workers",
			words: []string{"go", "is", "fun"},
			n:     2,
			want:  map[string]int{"go": 2, "is": 2, "fun": 3},
		},
		{
			name:  "single worker",
			words: []string{"a", "bb", "ccc"},
			n:     1,
			want:  map[string]int{"a": 1, "bb": 2, "ccc": 3},
		},
		{
			name:  "more workers than words",
			words: []string{"hi", "there"},
			n:     8,
			want:  map[string]int{"hi": 2, "there": 5},
		},
		{
			name:  "empty input",
			words: []string{},
			n:     3,
			want:  map[string]int{},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := process(tt.words, tt.n)
			if len(tt.want) == 0 {
				if len(got) != 0 {
					t.Fatalf("got %v, want empty map", got)
				}
				return
			}
			if !reflect.DeepEqual(got, tt.want) {
				t.Fatalf("got %v, want %v", got, tt.want)
			}
		})
	}
}

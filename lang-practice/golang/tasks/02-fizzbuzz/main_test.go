package main

import (
	"reflect"
	"testing"
)

func TestFizzBuzz(t *testing.T) {
	tests := []struct {
		name string
		n    int
		want []string
	}{
		{name: "zero", n: 0, want: nil},
		{name: "negative", n: -1, want: nil},
		{
			name: "first fifteen",
			n:    15,
			want: []string{
				"1", "2", "Fizz", "4", "Buzz",
				"Fizz", "7", "8", "Fizz", "Buzz",
				"11", "Fizz", "13", "14", "FizzBuzz",
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := FizzBuzz(tt.n)
			if !reflect.DeepEqual(got, tt.want) {
				t.Fatalf("FizzBuzz(%d) = %#v, want %#v", tt.n, got, tt.want)
			}
		})
	}
}

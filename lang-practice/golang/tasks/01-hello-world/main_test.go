package main

import "testing"

func TestGreet(t *testing.T) {
	tests := []struct {
		name string
		in   string
		want string
	}{
		{name: "default", in: "", want: "hello, world"},
		{name: "named", in: "gopher", want: "hello, gopher"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := Greet(tt.in); got != tt.want {
				t.Fatalf("Greet(%q) = %q, want %q", tt.in, got, tt.want)
			}
		})
	}
}

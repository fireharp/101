package fixingdirections

import "testing"

func TestSubmitReceive(t *testing.T) {
	str := "one,two,,four"
	stream := make(chan string)
	go submit(str, stream)
	got := receive(stream)
	want := "one two four"
	if got != want {
		t.Fatalf("got %q, want %q", got, want)
	}
}

package wordfrequency

import "testing"

func TestCountWords(t *testing.T) {
	in := generate(20)
	m := countWords(in)
	if len(m) == 0 {
		t.Fatal("empty result")
	}
}

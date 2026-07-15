package cancelinggenerator

import (
	"context"
	"testing"
)

func TestGenerateCancel(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	out := generate(ctx, "one two three")
	count := 0
	for range out {
		count++
	}
	if count >= 3 {
		t.Fatalf("expected cancel before all words, got %d", count)
	}
}

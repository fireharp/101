package pipelinewithcontext

import (
	"context"
	"testing"
)

func TestCountStage(t *testing.T) {
	ctx := context.Background()
	in := make(chan string, 2)
	in <- "a1"
	in <- "22"
	close(in)
	out := make(chan int, 2)
	countStage(ctx, in, out)
	if <-out != 1 || <-out != 2 {
		t.Fatal("unexpected counts")
	}
}

package testingpipeline

import "testing"

func TestCountStage(t *testing.T) {
	in := make(chan string, 2)
	in <- "a1"
	in <- "22"
	close(in)
	out := make(chan int, 2)
	go countStage(in, out)
	if <-out != 1 || <-out != 2 {
		t.Fatal("wrong counts")
	}
}

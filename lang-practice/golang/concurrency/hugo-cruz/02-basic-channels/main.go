package basicchannels

import "sync"

// RunProducerConsumer runs a producer-consumer pipeline for numbers 1-10
// and returns the values consumed, in order.
func RunProducerConsumer() []int {
	ch := make(chan int)
	var wg sync.WaitGroup
	consumed := make([]int, 0, 10)

	// TODO: implement producer and consumer goroutines.
	_ = ch
	_ = wg
	_ = consumed

	return consumed
}

package mergenchannels

import "sync"

func Merge(channels ...chan string) <-chan string {
	c := make(chan string)

	var wg sync.WaitGroup
	wg.Add(len(channels))

	forward := func(ch chan string) {
		defer wg.Done()
		for v := range ch {
			c <- v
		}
	}

	for _, ch := range channels {
		go forward(ch)
	}

	go func() {
		wg.Wait()
		close(c)
	}()

	return c
}

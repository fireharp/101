package mergetwochannels

import "sync"

func Merge1(a <-chan string, b <-chan string) <-chan string {
	c := make(chan string)

	var wg sync.WaitGroup
	wg.Add(2)

	forward := func(ch <-chan string) {
		defer wg.Done()
		for v := range ch {
			c <- v
		}
	}

	go forward(a)
	go forward(b)

	go func() {
		wg.Wait()
		close(c)
	}()

	return c
}


func Merge(a <-chan string, b <-chan string) <-chan string {
	c := make(chan string)
	go func() {
		defer close(c)
		for a != nil || b != nil {
			select {
			case v, ok := <-a:
				if !ok {
					a = nil
					continue
				}
				c <- v
			case v, ok := <-b:
				if !ok {
					b = nil
					continue
				}
				c <- v
			}
		}
	}()
	return c
}


func MergeNonIdiomatic(a <-chan string, b <-chan string) <-chan string {
	c := make(chan string)
	done := make(chan struct{}, 2)

	go func() {
		for v := range a {
			c <- v
		}
		done <- struct{}{}
	}()
	go func() {
		for v := range b {
			c <- v
		}
		done <- struct{}{}
	}()
	go func() {
		<-done
		<-done
		close(c)
	}()
	return c
}

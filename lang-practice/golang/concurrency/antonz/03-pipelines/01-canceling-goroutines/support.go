package cancelinggoroutines

import "time"

func slowSend(out chan<- int, n int) {
	for i := 0; i < n; i++ {
		time.Sleep(5 * time.Millisecond)
		out <- i
	}
}

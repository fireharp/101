package main

import (
	"fmt"
	"strconv"
)

func FizzBuzz(n int) []string {
	if n <= 0 {
		return nil
	}

	out := make([]string, n)
	for i := 1; i <= n; i++ {
		switch {
		case i%15 == 0:
			out[i-1] = "FizzBuzz"
		case i%3 == 0:
			out[i-1] = "Fizz"
		case i%5 == 0:
			out[i-1] = "Buzz"
		default:
			out[i-1] = strconv.Itoa(i)
		}
	}
	return out
}

func main() {
	for _, v := range FizzBuzz(15) {
		fmt.Println(v)
	}
}

package main

import "fmt"

func Greet(name string) string {
	if name == "" {
		name = "world"
	}
	return fmt.Sprintf("hello, %s", name)
}

func main() {
	fmt.Println(Greet("gopher"))
}

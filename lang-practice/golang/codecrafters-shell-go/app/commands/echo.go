package commands

import (
	"fmt"
	"strings"
)

func init() {
	Register("echo", echo)
}

func echo(args []string) Result {
	fmt.Println(strings.Join(args[1:], " "))
	return Result{}
}

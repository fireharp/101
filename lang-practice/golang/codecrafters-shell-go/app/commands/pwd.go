package commands

import (
	"fmt"
	"os"
)

func init() {
	Register("pwd", pwd)
}

func pwd(args []string) Result {
	dir, err := os.Getwd()
	if err != nil {
		return Result{Handled: false}
	}
	fmt.Println(dir)
	return Result{Handled: true}
}

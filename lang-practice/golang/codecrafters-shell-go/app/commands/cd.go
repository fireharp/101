package commands

import (
	"fmt"
	"os"
	"strings"
)

func init() {
	Register("cd", cd)
}

func cd(args []string) Result {
	if len(args) < 2 {
		return Result{Handled: false}
	}
	dir := args[1]
	if strings.HasPrefix(dir, "~") {
		dir = strings.Replace(dir, "~", os.Getenv("HOME"), 1)
	}
	err := os.Chdir(dir)
	if err != nil {
		fmt.Printf("cd: %s: No such file or directory\n", dir)
		return Result{Handled: false}
	}
	return Result{Handled: true}
}

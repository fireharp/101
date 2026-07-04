package commands

import (
	"fmt"
	"slices"
)

func init() {
	Register("type", typeCommand)
}

func typeCommand(args []string) Result {
	if len(args) < 2 {
		return Result{Handled: false}
	}

	arg1 := args[1]
	if slices.Contains(Names(), arg1) {
		fmt.Printf("%s is a shell builtin\n", arg1)
		return Result{Handled: true}
	} else if path, ok := SearchPath(arg1); ok {
		fmt.Printf("%s is %s\n", arg1, path)
		return Result{Handled: true}
	} else {
		fmt.Printf("%s: not found\n", arg1)
		return Result{Handled: true}
	}
}

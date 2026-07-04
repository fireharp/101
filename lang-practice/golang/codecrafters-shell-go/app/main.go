package main

import (
	"bufio"
	"fmt"
	"os"
	"strings"

	"github.com/codecrafters-io/shell-starter-go/app/commands"
)

func main() {
	reader := bufio.NewReader(os.Stdin)
	for {
		fmt.Print("$ ")
		command, err := reader.ReadString('\n')
		if err != nil {
			fmt.Println("Error reading command:", err)
		}
		args := strings.Split(strings.TrimSpace(command), " ")

		if handler, ok := commands.Lookup(args[0]); ok {
			if result := handler(args); result.ExitREPL {
				break
			}
			continue
		}

		if _, ok := commands.SearchPath(args[0]); ok {
			commands.RunExternalCommand(args[0], args[1:])
			continue
		}

		fmt.Printf("%s: command not found\n", args[0])
	}
}

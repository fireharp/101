package commands

import (
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
)

func SearchPath(arg1 string) (string, bool) {
	path := os.Getenv("PATH")
	paths := strings.Split(path, ":")
	for _, p := range paths {
		filePath := filepath.Join(p, arg1)
		if _, err := exec.LookPath(filePath); err == nil {
			return filePath, true
		}
	}
	return "", false
}

func RunExternalCommand(command string, args []string) {
	cmd := exec.Command(command, args...)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	cmd.Run()
}

var singleQuoteRegex = regexp.MustCompile(`'[^']*'`)

func ParseInputToArgs(input string) []string {
	input = strings.TrimSpace(input)
	if input == "" {
		return []string{}
	}
	/*
	*  Single quote: ' -> parse as a single argument
	 */
	// Use regex to split input into words or single-quoted sections
	tokenRegex := regexp.MustCompile(`'[^']*'|\w+`)
	matches := tokenRegex.FindAllString(input, -1)
	for _, match := range matches {
		input = strings.Replace(input, match, "", 1)
	}
	return strings.Split(strings.TrimSpace(input), " ")
}

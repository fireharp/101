package commands

import (
	"os"
	"os/exec"
	"path/filepath"
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

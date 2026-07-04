//go:build debug

package debug

import "fmt"

const Enabled = true

func Println(v ...any) {
	fmt.Println(v...)
}

func Printf(format string, v ...any) {
	fmt.Printf(format, v...)
}

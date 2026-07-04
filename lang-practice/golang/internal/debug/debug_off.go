//go:build !debug

package debug

const Enabled = false

func Println(v ...any) {}

func Printf(format string, v ...any) {}

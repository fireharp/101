//go:build ignore

// Copy the block below into package main on HackerRank / LeetCode / etc.
// Remove any import of lang-practice/golang/internal/debug first.
//
// To print while debugging on a judge, uncomment the fmt lines inside Println/Printf.

package main

import "fmt"

var debug = struct {
	Enabled bool
	Println func(v ...any)
	Printf  func(format string, v ...any)
}{
	Enabled: false,
	Println: func(v ...any) {
		_ = fmt.Println // keep fmt imported when uncommenting
		// fmt.Println(v...)
	},
	Printf: func(format string, v ...any) {
		_ = fmt.Printf
		// fmt.Printf(format, v...)
	},
}

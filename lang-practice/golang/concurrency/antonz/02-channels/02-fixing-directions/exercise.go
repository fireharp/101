package fixingdirections

import "strings"

// submit splits str by comma and sends words to stream.
func submit(str string, stream chan<- string) {
	// TODO: fix channel direction in signature; split and send words, then close.
	words := strings.Split(str, ",")
	for _, word := range words {
		stream <- word
	}
	close(stream)
}

// receive reads from stream and returns non-empty words joined by spaces.
func receive(stream <-chan string) string {
	// TODO: fix channel direction in signature.
	result := make([]string, 0)
	for v := range stream {
		if v != "" {
			result = append(result, v)
		}
	}
	return strings.Join(result, " ")
}

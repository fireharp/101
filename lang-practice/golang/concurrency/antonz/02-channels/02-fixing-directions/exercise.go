package fixingdirections

// submit splits str by comma and sends words to stream.
func submit(str string, stream chan string) {
	// TODO: fix channel direction in signature; split and send words, then close.
	_ = str
	_ = stream
}

// receive reads from stream and returns non-empty words joined by spaces.
func receive(stream chan string) string {
	// TODO: fix channel direction in signature.
	_ = stream
	return ""
}

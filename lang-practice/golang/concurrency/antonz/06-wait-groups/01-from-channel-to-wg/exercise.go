package fromchanneltowg

// runAndWait runs fn in a goroutine and blocks until it completes.
func runAndWait(fn func()) {
	// TODO: replace done channel pattern with WaitGroup
	_ = fn
}

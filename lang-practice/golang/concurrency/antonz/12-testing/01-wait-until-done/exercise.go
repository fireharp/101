package waituntildone

// waitUntilDone runs fn in a goroutine and blocks until it completes.
func waitUntilDone(fn func()) {
	// TODO: use done channel or WaitGroup (test helper)
	_ = fn
}

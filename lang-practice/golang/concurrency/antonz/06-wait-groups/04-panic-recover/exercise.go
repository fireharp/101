package panicrecover

// RunConcSafe runs funcs concurrently; returns first panic value as error, or nil.
func RunConcSafe(funcs ...func()) (panicked bool) {
	// TODO: per-goroutine recover
	_ = funcs
	return false
}

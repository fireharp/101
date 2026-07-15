package wordfrequency

// countWords counts word frequencies from in using two goroutines safely.
func countWords(in <-chan string) map[string]int {
	// TODO: avoid concurrent map writes — use separate maps + merge
	_ = in
	return nil
}

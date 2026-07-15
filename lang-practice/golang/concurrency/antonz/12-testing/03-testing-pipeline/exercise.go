package testingpipeline

// countStage reads words, sends digit counts to out.
func countStage(in <-chan string, out chan<- int) {
	// TODO: implement stage (then test it in exercise_test.go)
	for range in {
		out <- 0
	}
}

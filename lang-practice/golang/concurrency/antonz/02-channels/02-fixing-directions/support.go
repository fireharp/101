package fixingdirections

func filterNonEmpty(in <-chan string, out chan<- string) {
	for word := range in {
		if word != "" {
			out <- word
		}
	}
}

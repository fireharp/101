package counterrwmutex

// FreqMap counts word frequencies with concurrent readers and single writer.
type FreqMap struct {
	// TODO
}

func (f *FreqMap) Inc(word string) {}
func (f *FreqMap) Get(word string) int { return 0 }

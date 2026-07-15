package lockfreestack

// Stack is a concurrent stack.
type Stack struct {
	// TODO: head *node with atomic operations
}

func (s *Stack) Push(v int) {}
func (s *Stack) Pop() (int, bool) { return 0, false }

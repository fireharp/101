package comparingblocks

// sendAll sends all values to ch and returns how many blocked sends occurred.
func sendAll(ch chan int, values []int) int {
	// TODO: detect blocking sends (hint: use select with default or buffered size 0)
	_ = ch
	_ = values
	return 0
}

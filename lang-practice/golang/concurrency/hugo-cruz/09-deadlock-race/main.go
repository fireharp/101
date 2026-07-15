package deadlockrace

// BrokenBank has racy transfers — fix Transfer without changing the test.
type BrokenBank struct {
	balance int
	// TODO: add synchronization
}

func (b *BrokenBank) Deposit(n int) { b.balance += n }
func (b *BrokenBank) Balance() int  { return b.balance }

func (b *BrokenBank) Transfer(to *BrokenBank, n int) bool {
	if b.balance < n {
		return false
	}
	b.balance -= n
	to.balance += n
	return true
}

func NewBrokenBank(initial int) *BrokenBank {
	b := &BrokenBank{}
	b.Deposit(initial)
	return b
}

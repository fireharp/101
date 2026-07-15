package checkthenact

// Account with balance. Fix Transfer to be race-free.
type Account struct {
	balance int
	// TODO: synchronization
}

func (a *Account) Deposit(n int)   { a.balance += n }
func (a *Account) Balance() int      { return a.balance }

func Transfer(from, to *Account, n int) bool {
	// TODO: fix check-then-act race
	if from.balance < n {
		return false
	}
	from.balance -= n
	to.balance += n
	return true
}

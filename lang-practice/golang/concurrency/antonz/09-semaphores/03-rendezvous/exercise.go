package rendezvous

// Rendezvous synchronizes two goroutines at a meeting point.
type Rendezvous struct {
	// TODO
}

func NewRendezvous() *Rendezvous { return &Rendezvous{} }

func (r *Rendezvous) Meet() {
	// TODO: both goroutines block until the other arrives
}

package contextcancel

import (
	"context"
	"time"
)

// RunUntilCancelled runs until ctx is canceled, then returns ctx.Err().
func RunUntilCancelled(ctx context.Context) error {
	// TODO: loop with select on ctx.Done()
	_ = ctx
	time.Sleep(time.Millisecond)
	return nil
}

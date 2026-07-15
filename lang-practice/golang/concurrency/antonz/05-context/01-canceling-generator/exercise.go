package cancelinggenerator

import "context"

// generate sends words from phrase until ctx is canceled or all words sent.
func generate(ctx context.Context, phrase string) <-chan string {
	out := make(chan string)
	go func() {
		close(out)
	}()
	// TODO: goroutine with select on ctx.Done()
	_ = ctx
	_ = phrase
	return out
}

# 08-context-cancel

Source: [Hugo-cruz/golang-concurrency-exercises](https://github.com/Hugo-cruz/golang-concurrency-exercises)

Implement `RunUntilCancelled(ctx context.Context) error` — simulate a long-running task that returns `ctx.Err()` when canceled.

## Test

```bash
make test concurrency/hugo-cruz/08-context-cancel
```

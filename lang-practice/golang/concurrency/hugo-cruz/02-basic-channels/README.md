# 02-basic-channels

Source: [Hugo-cruz/golang-concurrency-exercises](https://github.com/Hugo-cruz/golang-concurrency-exercises)

Implement `RunProducerConsumer()`:

- **Producer** sends numbers 1–10 through a channel (sleep 100ms between sends), then closes the channel.
- **Consumer** receives numbers and collects them (sleep 150ms per item).
- Use `sync.WaitGroup` so both complete before returning.

Return the consumed values in order.

## Test

```bash
make test concurrency/hugo-cruz/02-basic-channels
```

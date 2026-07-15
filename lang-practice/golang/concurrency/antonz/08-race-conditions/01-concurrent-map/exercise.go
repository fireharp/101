package concurrentmaprc

import "sync"

// LazyMap lazily initializes values per key. Fix the race condition.
type LazyMap struct {
	mu sync.Mutex
	m  map[string]int
}

func (l *LazyMap) GetOrCreate(key string, init func() int) int {
	// TODO: fix race — entire check-then-act must be atomic
	if l.m == nil {
		l.m = make(map[string]int)
	}
	if v, ok := l.m[key]; ok {
		return v
	}
	v := init()
	l.m[key] = v
	return v
}

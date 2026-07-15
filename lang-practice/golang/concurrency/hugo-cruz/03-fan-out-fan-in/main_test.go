package fanoutfanin

import (
	"sort"
	"testing"
	"time"
)

func generateLogChannel(logs []string, delay time.Duration) <-chan string {
	ch := make(chan string)
	go func() {
		defer close(ch)
		for _, log := range logs {
			time.Sleep(delay)
			ch <- log
		}
	}()
	return ch
}

func collectLogs(out <-chan string) []string {
	var results []string
	for log := range out {
		results = append(results, log)
	}
	sort.Strings(results)
	return results
}

func TestMergeLogsBasic(t *testing.T) {
	ch1 := generateLogChannel([]string{"log1", "log2", "log3"}, 10*time.Millisecond)
	ch2 := generateLogChannel([]string{"logA", "logB"}, 15*time.Millisecond)

	output := MergeLogs(ch1, ch2)
	results := collectLogs(output)

	want := []string{"log1", "log2", "log3", "logA", "logB"}
	if len(results) != len(want) {
		t.Fatalf("expected %d logs, got %d: %v", len(want), len(results), results)
	}
	sort.Strings(want)
	if !equalSorted(results, want) {
		t.Fatalf("got %v, want %v", results, want)
	}
}

func TestMergeLogsEmptyChannels(t *testing.T) {
	output := MergeLogs()

	select {
	case _, open := <-output:
		if open {
			t.Error("expected output channel to be closed immediately")
		}
	case <-time.After(50 * time.Millisecond):
		t.Error("timeout waiting for channel closure")
	}
}

func TestMergeLogsConcurrentInputs(t *testing.T) {
	ch1 := generateLogChannel([]string{"A", "B", "C"}, 5*time.Millisecond)
	ch2 := generateLogChannel([]string{"1", "2", "3"}, 5*time.Millisecond)
	ch3 := generateLogChannel([]string{"X", "Y"}, 8*time.Millisecond)

	output := MergeLogs(ch1, ch2, ch3)
	results := collectLogs(output)

	want := []string{"1", "2", "3", "A", "B", "C", "X", "Y"}
	if !equalSorted(results, want) {
		t.Fatalf("got %v, want %v", results, want)
	}
}

func TestMergeLogsSingleChannel(t *testing.T) {
	ch := generateLogChannel([]string{"OnlyOne"}, 5*time.Millisecond)
	output := MergeLogs(ch)

	count := 0
	for range output {
		count++
	}
	if count != 1 {
		t.Fatalf("expected 1 log, got %d", count)
	}
}

func equalSorted(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	sort.Strings(a)
	sort.Strings(b)
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

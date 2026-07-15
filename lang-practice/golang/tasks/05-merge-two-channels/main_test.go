package mergetwochannels

import (
	"testing"

	. "github.com/onsi/ginkgo"
	. "github.com/onsi/gomega"
)

func TestMergeTwoChannels(t *testing.T) {
	RegisterFailHandler(Fail)
	RunSpecs(t, "Merge Two Channels Suite")
}

func consume(c <-chan string) []string {
	var msgs []string
	for m := range c {
		msgs = append(msgs, m)
	}
	return msgs
}

var _ = Describe("Sample Test", func() {
	It("should merge 3 messages from a and 2 messages from b", func() {
		a := make(chan string, 3)
		a <- "foo"
		a <- "bar"
		a <- "baz"
		close(a)

		b := make(chan string, 2)
		b <- "hello"
		b <- "world"
		close(b)

		c := Merge(a, b)

		actual := consume(c)
		expected := []string{"hello", "world", "foo", "bar", "baz"}

		Expect(actual).To(ConsistOf(expected))
	})

	It("should consume from a while b stays empty", func() {
		a := make(chan string)
		b := make(chan string)

		go func() {
			a <- "first"
			a <- "second"
			a <- "third"
			close(a)
			close(b)
		}()

		c := Merge(a, b)

		Expect(consume(c)).To(ConsistOf([]string{"first", "second", "third"}))
	})

	It("should consume from b while a stays empty", func() {
		a := make(chan string)
		b := make(chan string)

		go func() {
			b <- "first"
			b <- "second"
			b <- "third"
			close(a)
			close(b)
		}()

		c := Merge(a, b)

		Expect(consume(c)).To(ConsistOf([]string{"first", "second", "third"}))
	})
})

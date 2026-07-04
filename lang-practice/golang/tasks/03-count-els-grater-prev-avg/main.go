package main

import (
	"bufio"
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"

	"lang-practice/golang/internal/debug"
)

/*
 * Complete the 'countResponseTimeRegressions' function below.
 *
 * The function is expected to return an INTEGER.
 * The function accepts INTEGER_ARRAY responseTimes as parameter.
 */

// --- copy-paste block: uncomment stub, drop internal/debug import, copy through function end ---
/*
var debug = struct {
	Println func(v ...any)
	Printf  func(format string, v ...any)
}{
	Println: func(v ...any) {},
	Printf:  func(format string, v ...any) {},
}
*/

func countResponseTimeRegressions(responseTimes []int32) int32 {
	// Write your code here
	// responseTimes: [10, 5, 15, 11] elements
	debug.Println("responseTimes: ", responseTimes) // debug.Println is a no-op in release builds
	if len(responseTimes) < 2 {
		return 0
	}

	count := int32(0)
	sumPrev := int64(responseTimes[0])
	for i := 1; i < len(responseTimes); i++ {
		avgPrev := float64(sumPrev) / float64(i)
		debug.Println("responseTimes[i]: ", responseTimes[i], "avgPrev:", avgPrev)
		if float64(responseTimes[i]) > avgPrev {
			count++
			debug.Println("count: ", count)
		}
		sumPrev += int64(responseTimes[i])
	}

	debug.Println("return count: ", count)
	return count
}

func main() {
	reader := bufio.NewReaderSize(os.Stdin, 16*1024*1024)

	responseTimesCount, err := strconv.ParseInt(strings.TrimSpace(readLine(reader)), 10, 64)
	checkError(err)

	var responseTimes []int32

	for i := 0; i < int(responseTimesCount); i++ {
		responseTimesItemTemp, err := strconv.ParseInt(strings.TrimSpace(readLine(reader)), 10, 64)
		checkError(err)
		responseTimesItem := int32(responseTimesItemTemp)
		responseTimes = append(responseTimes, responseTimesItem)
	}

	result := countResponseTimeRegressions(responseTimes)

	fmt.Printf("%d\n", result)
}

func readLine(reader *bufio.Reader) string {
	str, _, err := reader.ReadLine()
	if err == io.EOF {
		return ""
	}

	return strings.TrimRight(string(str), "\r\n")
}

func checkError(err error) {
	if err != nil {
		panic(err)
	}
}

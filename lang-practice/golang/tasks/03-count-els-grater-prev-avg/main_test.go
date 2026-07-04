package main

import "testing"

func TestCountResponseTimeRegressions(t *testing.T) {
	tests := []struct {
		name          string
		responseTimes []int32
		want          int32
	}{
		{name: "empty slice", responseTimes: nil, want: 0},
		{name: "single element", responseTimes: []int32{42}, want: 0},
		{name: "two elements rising", responseTimes: []int32{10, 20}, want: 1},
		{name: "two elements falling", responseTimes: []int32{20, 10}, want: 0},
		{name: "all equal", responseTimes: []int32{10, 10, 10, 10}, want: 0},
		{name: "strictly increasing", responseTimes: []int32{1, 2, 3, 4}, want: 3},
		{name: "spike then drop", responseTimes: []int32{1, 100, 2}, want: 1},
		{name: "no regressions mixed", responseTimes: []int32{100, 50, 75, 25}, want: 0},
		{
			name:          "uses full previous average not rolling pair average",
			responseTimes: []int32{10, 5, 15, 11},
			want:          2, // 15 > avg(10,5)=7; 11 > avg(10,5,15)=10
		},
		{
			name:          "equal to truncated previous average is not counted",
			responseTimes: []int32{10, 5, 15, 10},
			want:          1, // 15 > avg(10,5)=7; avg(10,5,15)=10 so 10 > 10 is false
		},
		{
			name:          "hacker rank sample",
			responseTimes: []int32{100, 200, 150, 300},
			want:          2,
		},
		{
			name:          "float average prev only not current",
			responseTimes: []int32{100, 201, 150},
			want:          1, // 201>100; 150 > 150.5 is false
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := countResponseTimeRegressions(tt.responseTimes)
			if got != tt.want {
				t.Fatalf("countResponseTimeRegressions(%v) = %d, want %d", tt.responseTimes, got, tt.want)
			}
		})
	}
}

package main

import "fmt"

func filter[T any](input []T, fn func(T) bool, keep bool) []T {
    res := make([]T, 0, len(input))
    for i:=0; i < len(input); i++ {
        b := fn(input[i])
        if keep && b {
			res = append(res, input[i])
        } else if !keep && b {
            res = append(res, input[i])
        }
    }
    return res
}

func Keep[T any](input []T, fn func(T) bool) []T{
    fmt.Println("Keep: ", input)
    return filter[T](input, fn, true)
}

func Discard[T any](input []T, fn func(T) bool) []T{
    fmt.Println("Discard: ", input)
    return filter[T](input, fn, false)
}

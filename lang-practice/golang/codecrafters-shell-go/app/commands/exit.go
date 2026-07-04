package commands

func init() {
	Register("exit", exit)
}

func exit(args []string) Result {
	return Result{ExitREPL: true}
}

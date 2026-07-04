package commands

type Result struct {
	ExitREPL bool
	Handled  bool
}

type Handler func(args []string) Result

var registry = make(map[string]Handler)

func Register(name string, handler Handler) {
	registry[name] = handler
}

func Lookup(name string) (Handler, bool) {
	handler, ok := registry[name]
	return handler, ok
}

func IsBuiltin(name string) bool {
	_, ok := registry[name]
	return ok
}

func Names() []string {
	names := make([]string, 0, len(registry))
	for name := range registry {
		names = append(names, name)
	}
	return names
}

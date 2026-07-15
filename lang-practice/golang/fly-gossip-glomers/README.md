https://fly.io/dist-sys/

## Maelstrom setup

Maelstrom is not vendored in this repo. Install it locally before running tests:

1. Download `maelstrom.tar.bz2` (not the source tarball) from [GitHub releases](https://github.com/jepsen-io/maelstrom/releases/latest).
2. Extract into `lang-practice/golang/fly-gossip-glomers/maelstrom/`.
3. Install prerequisites: JDK 11+, [Graphviz](https://graphviz.org/), and [Gnuplot](http://www.gnuplot.info/).

Then run from that directory, for example:

```bash
cd lang-practice/golang/fly-gossip-glomers/maelstrom
./maelstrom test -w echo --bin demo/ruby/echo.rb --time-limit 5
```

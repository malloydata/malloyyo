// antlr4ts/misc/BitSet.js requires("util") for exactly one thing: the
// `util.inspect.custom` symbol, used to pretty-print in a Node REPL. The npm
// `util` polyfill that satisfies it is large and references `process`.
const inspect = (v) => String(v);
inspect.custom = Symbol.for("nodejs.util.inspect.custom");

module.exports = { inspect, default: { inspect } };

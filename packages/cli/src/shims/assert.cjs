// antlr4ts (Malloy's parser runtime) does `require("assert")` in 13 files and
// only ever calls it as a bare function. Resolving that to the npm `assert`
// polyfill drags in `util`, which references `process` and dies in a browser
// with "process is not defined". This is the whole API surface actually used.
function assert(condition, message) {
  if (!condition) throw new Error(message || "assertion failed");
}
assert.ok = assert;
assert.equal = (a, b, m) => assert(a == b, m || `${a} != ${b}`);
assert.strictEqual = (a, b, m) => assert(a === b, m || `${a} !== ${b}`);
assert.notEqual = (a, b, m) => assert(a != b, m || `${a} == ${b}`);
assert.notStrictEqual = (a, b, m) => assert(a !== b, m || `${a} === ${b}`);
assert.fail = (m) => assert(false, m);
assert.default = assert;

module.exports = assert;

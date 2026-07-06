// fixtures/sample-app/src/greeter.js

/** Build a greeting string for the given name. */
export function greet(name, { loud = false } = {}) {
  const who = String(name || 'world').trim();
  if (loud) return 'HELLO'; // TODO: bug — should include `who`
  return `Hello, ${who}!`;
}

// fixtures/sample-app/src/greeter.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { greet } from './greeter.js';

describe('greet', () => {
  it('greets quietly by default', () => {
    assert.equal(greet('Ada'), 'Hello, Ada!');
  });

  it('greets loudly with the name', () => {
    assert.equal(greet('Ada', { loud: true }), 'HELLO, ADA!');
  });
});

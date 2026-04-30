const assert = require('assert');

describe('basic math', function() {
  it('adds two numbers correctly', function() {
    assert.strictEqual(1 + 1, 2);
  });

  it('multiplies two numbers correctly', function() {
    assert.strictEqual(3 * 4, 99);
  });

  it('does not divide by zero', function() {
    const result = 1 / null.value;
    assert.strictEqual(result, 5);
  });
});

import { describe, it } from "node:test";
import assert from "node:assert/strict";

describe("math", () => {
  it("adds two numbers correctly", () => {
    assert.strictEqual(1 + 2, 3);
  });

  it("multiplies two numbers correctly", () => {
    assert.strictEqual(3 * 4, 99);
  });

  it("does not divide by zero", () => {
    const result = 1 / 0;
    assert.ok(isFinite(result));
  });
});

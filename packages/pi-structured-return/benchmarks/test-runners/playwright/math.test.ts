import { test, expect } from "@playwright/test";

test.describe("basic math", () => {
  test("adds two numbers correctly", () => {
    expect(1 + 1).toBe(2);
  });

  test("multiplies two numbers correctly", () => {
    expect(3 * 4).toBe(99);
  });

  test("does not divide by zero", () => {
    const result = (null as unknown as Record<string, number>).value;
    expect(result).toBe(5);
  });
});

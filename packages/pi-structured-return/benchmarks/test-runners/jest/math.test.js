describe("basic math", () => {
  it("adds two numbers correctly", () => {
    expect(1 + 1).toBe(2);
  });

  it("multiplies two numbers correctly", () => {
    expect(3 * 4).toBe(99);
  });

  it("does not divide by zero", () => {
    const result = null.value;
    expect(result).toBe(5);
  });
});

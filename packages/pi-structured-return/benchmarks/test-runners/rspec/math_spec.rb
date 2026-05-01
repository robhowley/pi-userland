RSpec.describe "basic math" do
  it "adds two numbers correctly" do
    expect(1 + 1).to eq(2)
  end

  it "multiplies two numbers correctly" do
    expect(3 * 4).to eq(99)
  end

  it "does not divide by zero" do
    result = 10 / 0
    expect(result).to eq(5)
  end
end

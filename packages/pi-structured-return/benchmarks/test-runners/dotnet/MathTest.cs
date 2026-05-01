namespace Benchmark;

public class MathTest
{
    [Fact]
    public void AddsTwoNumbersCorrectly()
    {
        Assert.Equal(2, 1 + 1);
    }

    [Fact]
    public void MultipliesTwoNumbersCorrectly()
    {
        Assert.Equal(99, 3 * 4);
    }

    [Fact]
    public void DoesNotThrowOnNullAccess()
    {
        string? s = null;
        int result = s!.Length;
        Assert.Equal(5, result);
    }
}

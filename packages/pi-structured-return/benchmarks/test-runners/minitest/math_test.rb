require "minitest/autorun"

class MathTest < Minitest::Test
  def test_adds_two_numbers_correctly
    assert_equal 2, 1 + 1
  end

  def test_multiplies_two_numbers_correctly
    assert_equal 99, 3 * 4
  end

  def test_does_not_divide_by_zero
    result = 10 / 0
    assert_equal 5, result
  end
end

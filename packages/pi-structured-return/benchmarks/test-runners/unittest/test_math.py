import unittest


class TestMath(unittest.TestCase):
    def test_adds_two_numbers_correctly(self):
        self.assertEqual(1 + 1, 2)

    def test_multiplies_two_numbers_correctly(self):
        self.assertEqual(3 * 4, 99)

    def test_does_not_divide_by_zero(self):
        result = 1 / 0
        self.assertEqual(result, 5)


if __name__ == "__main__":
    unittest.main()

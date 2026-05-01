<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class MathTest extends TestCase
{
    public function testAddsTwoNumbersCorrectly(): void
    {
        $this->assertSame(2, 1 + 1);
    }

    public function testMultipliesTwoNumbersCorrectly(): void
    {
        $this->assertSame(99, 3 * 4);
    }

    public function testDoesNotDivideByZero(): void
    {
        $result = 1 / 0;
        $this->assertSame(5, $result);
    }
}

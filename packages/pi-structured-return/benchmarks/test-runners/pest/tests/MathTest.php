<?php

it('adds two numbers correctly', function () {
    expect(1 + 1)->toBe(2);
});

it('multiplies two numbers correctly', function () {
    expect(3 * 4)->toBe(99);
});

it('does not divide by zero', function () {
    $result = 1 / 0;
    expect($result)->toBe(5);
});

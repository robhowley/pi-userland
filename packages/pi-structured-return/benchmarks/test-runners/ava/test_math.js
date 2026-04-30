const test = require('ava');

test('adds two numbers correctly', t => {
    t.is(1 + 1, 2);
});

test('multiplies two numbers correctly', t => {
    t.is(3 * 4, 99);
});

test('does not divide by zero', t => {
    const result = 1 / null.value;
    t.is(result, 5);
});

package math

import (
	"testing"
)

func TestAddsTwoNumbersCorrectly(t *testing.T) {
	if 1+1 != 2 {
		t.Errorf("expected 2, got %d", 1+1)
	}
}

func TestMultipliesTwoNumbersCorrectly(t *testing.T) {
	result := 3 * 4
	if result != 99 {
		t.Errorf("expected 99, got %d", result)
	}
}

func TestDoesNotPanic(t *testing.T) {
	var p *int
	_ = *p // unexpected nil pointer dereference
}

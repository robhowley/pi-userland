package math

import "testing"

func TestAddsTwoNumbersCorrectly(t *testing.T) {
	if Add(1, 1) != 2 {
		t.Error("expected 2")
	}
}

func TestMultipliesTwoNumbersCorrectly(t *testing.T) {
	got := Multiply(3, 4)
	if got != 99 {
		t.Errorf("expected 99, got %d", got)
	}
}

func TestDoesNotPanic(t *testing.T) {
	var s *string
	_ = *s // nil pointer dereference
}

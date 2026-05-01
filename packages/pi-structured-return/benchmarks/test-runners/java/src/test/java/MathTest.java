import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

class MathTest {

    @Test
    void addsTwoNumbersCorrectly() {
        assertEquals(2, 1 + 1);
    }

    @Test
    void multipliesTwoNumbersCorrectly() {
        assertEquals(99, 3 * 4);
    }

    @Test
    void doesNotDivideByZero() {
        int result = 1 / 0;
        assertEquals(5, result);
    }
}

pub fn add(a: i32, b: i32) -> i32 {
    a + b
}

pub fn multiply(a: i32, b: i32) -> i32 {
    a * b
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn adds_two_numbers_correctly() {
        assert_eq!(add(1, 1), 2);
    }

    #[test]
    fn multiplies_two_numbers_correctly() {
        assert_eq!(multiply(3, 4), 99);
    }

    #[test]
    fn does_not_panic() {
        let v: Vec<i32> = vec![];
        let _ = v[0]; // index out of bounds
    }
}

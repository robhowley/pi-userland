fn add(a: i32, b: i32) -> i32 {
    a + b
}

fn main() {
    let result: i32 = "not a number"; // E0308: mismatched types
    let _ = add(result, missing_var); // E0425: cannot find value
    println!("{}", result);
}

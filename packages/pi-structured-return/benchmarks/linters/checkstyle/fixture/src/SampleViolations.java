package fixture;

public class SampleViolations {
    // Violation: line too long (this comment is intentionally made very long to exceed the 80 character limit imposed by the configuration)
    
    public void badBraces() 
    {
        // Violation: LeftCurly — brace should be on same line
        if (true)
            System.out.println("no braces");  // Violation: NeedBraces
    }
    
    public void anotherViolation() {
        String s = "another intentionally long line to trigger the line length checkstyle rule violation";
    }
}

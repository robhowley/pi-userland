import { describe, it, expect } from 'vitest';
import { evaluate } from '../../extensions/yolo-seatbelt/evaluate.js';
import { RuleSeverity } from '../../extensions/yolo-seatbelt/rules.js';

describe('evaluate', () => {
  describe('BLOCK patterns', () => {
    it('blocks rm -rf /', () => {
      const result = evaluate('rm -rf /', { cwd: '/repo' });
      expect(result.decision).toBe(RuleSeverity.BLOCK);
      expect(result.message).toBe('BLOCK: rm -rf / would delete the entire filesystem');
    });

    it('blocks rm -rf .git', () => {
      const result = evaluate('rm -rf .git', { cwd: '/repo' });
      expect(result.decision).toBe(RuleSeverity.BLOCK);
      expect(result.matchedRule).toBe('rm-rf-git');
    });

    it('blocks rm -rf ~', () => {
      const result = evaluate('rm -rf ~', { cwd: '/repo' });
      expect(result.decision).toBe(RuleSeverity.BLOCK);
      expect(result.matchedRule).toBe('rm-rf-home');
    });
  });

  describe('PROTECTED_PATHS', () => {
    it('blocks paths matching .git', () => {
      const result = evaluate('ls /repo/.git/config', { cwd: '/repo' });
      expect(result.decision).toBe(RuleSeverity.BLOCK);
      expect(result.matchedRule).toBe('path-git');
    });

    it('blocks paths matching .env', () => {
      const result = evaluate('cat /repo/.env', { cwd: '/repo' });
      expect(result.decision).toBe(RuleSeverity.BLOCK);
      expect(result.matchedRule).toBe('path-env');
    });

    it('blocks paths matching .ssh', () => {
      const result = evaluate('cat /home/user/.ssh/id_rsa', { cwd: '/repo' });
      expect(result.decision).toBe(RuleSeverity.BLOCK);
    });
  });

  describe('workspace boundary', () => {
    it('asks for find -delete inside workspace', () => {
      // find -delete is ASK pattern, matches path inside workspace
      const result = evaluate('find /repo/src -delete', { cwd: '/repo' });
      expect(result.decision).toBe(RuleSeverity.ASK);
      expect(result.matchedRule).toBe('find-delete');    
    });

    it('asks for find -delete outside workspace', () => {
      // find -delete is ASK pattern - the rule matches and returns ASK regardless of path location
      const result = evaluate('find /etc/passwd -delete', { cwd: '/repo' });
      expect(result.decision).toBe(RuleSeverity.ASK);
      expect(result.matchedRule).toBe('find-delete');
    })
  });

  describe('ASK patterns', () => {
    it('asks for find with -delete', () => {
      const result = evaluate('find . -name "*.tmp" -delete', { cwd: '/repo' });
      expect(result.decision).toBe(RuleSeverity.ASK);
      expect(result.matchedRule).toBe('find-delete');
    });

    it('asks for chmod -R', () => {
      const result = evaluate('chmod -R 755 /path', { cwd: '/repo' });
      expect(result.decision).toBe(RuleSeverity.ASK);
      expect(result.matchedRule).toBe('chmod-recursive');
    });

    it('asks for chown -R', () => {
      const result = evaluate('chown -R user:group /path', { cwd: '/repo' });
      expect(result.decision).toBe(RuleSeverity.ASK);
      expect(result.matchedRule).toBe('chown-recursive');
    });

    it('asks for sudo', () => {
      const result = evaluate('sudo apt update', { cwd: '/repo' });
      expect(result.decision).toBe(RuleSeverity.ASK);
      expect(result.matchedRule).toBe('sudo');
    });

    it('asks for git reset --hard', () => {
      const result = evaluate('git reset --hard', { cwd: '/repo' });
      expect(result.decision).toBe(RuleSeverity.ASK);
      expect(result.matchedRule).toBe('git.reset-hard');
    });

    it('asks for git push with force', () => {
      const result = evaluate('git push --force', { cwd: '/repo' });
      expect(result.decision).toBe(RuleSeverity.ASK);
      expect(result.matchedRule).toBe('git.push-force');
    });
  });

  describe('ALLOW cases', () => {
    it('allows echo commands', () => {
      const result = evaluate('echo "hello world"', { cwd: '/repo' });
      expect(result.decision).toBe(RuleSeverity.ALLOW);
      expect(result.matchedRule).toBe('allow-default');
    });

    it('allows pytest', () => {
      const result = evaluate('pytest', { cwd: '/repo' });
      expect(result.decision).toBe(RuleSeverity.ALLOW);
      expect(result.matchedRule).toBe('allow-default');
    });

    it('allows git status', () => {
      const result = evaluate('git status', { cwd: '/repo' });
      expect(result.decision).toBe(RuleSeverity.ALLOW);
      expect(result.matchedRule).toBe('allow-default');
    });

    it('allows normal rm (not -rf)', () => {
      const result = evaluate('rm file.txt', { cwd: '/repo' });
      expect(result.decision).toBe(RuleSeverity.ALLOW);
      expect(result.matchedRule).toBe('allow-default');
    });
  });

  describe('DecisionResult structure', () => {
    it('includes decision, matchedRule, and message', () => {
      const result = evaluate('rm -rf /', { cwd: '/repo' });
      expect(result).toHaveProperty('decision');
      expect(result).toHaveProperty('matchedRule');
      expect(result).toHaveProperty('message');
      expect(typeof result.decision).toBe('string');
      expect(typeof result.matchedRule).toBe('string');
      expect(typeof result.message).toBe('string');
    });
  });

describe('evaluate > sed command edge cases', () => {
  // Test cases: [command, cwd, expectedDecision, expectedRule, description]
  const sedTestCases: [string, string, RuleSeverity, string, string][] = [
    // sed substitution patterns should NOT trigger outside-workspace
    ["sed -i '' '/immutable: true/d' /repo/file.txt", '/repo', RuleSeverity.ALLOW, 'allow-default', 'sed with delete pattern'],
    ["sed 's/pattern/replacement/g' /repo/file.txt", '/repo', RuleSeverity.ALLOW, 'allow-default', 'sed with substitution'],
    ["sed 's/foo/bar/' /repo/file.txt", '/repo', RuleSeverity.ALLOW, 'allow-default', 'sed with simple substitution'],
    ["sed '/pattern/d' /repo/file.txt", '/repo', RuleSeverity.ALLOW, 'allow-default', 'sed with delete'],
    // grep with regex patterns should NOT trigger outside-workspace
    ["grep -E '/^[a-z]+/g' /repo/file.txt", '/repo', RuleSeverity.ALLOW, 'allow-default', 'grep with regex'],
    // Path outside workspace with .. and .env (protected path) should be BLOCKED
    ["cat ../secrets/.env", '/repo', RuleSeverity.BLOCK, 'protected-path', 'path with .. escaping and .env (protected)'],
    // Absolute path outside workspace - no rule matches (outside-workspace pattern only matches ../)
    ["cat /etc/passwd", '/repo', RuleSeverity.ALLOW, 'allow-default', 'absolute path outside workspace (no rule match)'],
    // Real paths with directories should work
    ["ls /repo/src/main.ts", '/repo', RuleSeverity.ALLOW, 'allow-default', 'real path inside workspace'],
  ];

  it.each(sedTestCases)(
    'handles %p correctly',
    (command, cwd, expectedDecision, expectedRule, _description) => {
      const result = evaluate(command, { cwd });
      expect(result.decision).toBe(expectedDecision);
      expect(result.matchedRule).toBe(expectedRule);
    }
  );
});
})
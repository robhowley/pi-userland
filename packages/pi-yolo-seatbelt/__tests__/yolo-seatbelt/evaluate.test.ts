import { describe, it, expect } from 'vitest';
import { evaluate, Decision } from '../../extensions/yolo-seatbelt/evaluate.ts';

describe('evaluate', () => {
  describe('evaluation order', () => {
    it('BLOCK patterns have highest priority', () => {
      const result = evaluate('rm -rf /some/path', { cwd: '/repo' });
      expect(result.decision).toBe(Decision.BLOCK);
      expect(result.matchedRule).toBe('rm-rf-root');
    });

    it('PROTECTED_PATHS check before workspace boundary', () => {
      // ls /repo/.git doesn't match any BLOCK pattern but has protected path
      const result = evaluate('ls /repo/.git/config', { cwd: '/repo' });
      expect(result.decision).toBe(Decision.BLOCK);
      expect(result.matchedRule).toBe('protected-path');
    });

    it('workspace boundary check before ASK patterns', () => {
      // find with -delete is ASK pattern, not BLOCK - tests workspace boundary
      const result = evaluate('find /etc/passwd -delete', {
        cwd: '/repo',
        config: { rules: { 'outside-workspace': 'block' } },
      });
      expect(result.decision).toBe(Decision.BLOCK);
      expect(result.matchedRule).toBe('outside-workspace-block');
    });

    it('ASK patterns checked before default ALLOW', () => {
      const result = evaluate('find . -delete', { cwd: '/repo' });
      expect(result.decision).toBe(Decision.ASK);
      expect(result.matchedRule).toBe('find-delete');
    });

    it('default ALLOW for safe commands', () => {
      const result = evaluate('echo "hello"', { cwd: '/repo' });
      expect(result.decision).toBe(Decision.ALLOW);
      expect(result.matchedRule).toBe('allow-default');
    });
  });

  describe('BLOCK patterns', () => {
    it('blocks rm -rf /', () => {
      const result = evaluate('rm -rf /', { cwd: '/repo' });
      expect(result.decision).toBe(Decision.BLOCK);
      expect(result.message).toBe('Blocked: rm -rf / would delete the entire filesystem');
    });

    it('blocks rm -rf .git', () => {
      const result = evaluate('rm -rf .git', { cwd: '/repo' });
      expect(result.decision).toBe(Decision.BLOCK);
      expect(result.matchedRule).toBe('rm-rf-git');
    });

    it('blocks rm -rf ~', () => {
      const result = evaluate('rm -rf ~', { cwd: '/repo' });
      expect(result.decision).toBe(Decision.BLOCK);
      expect(result.matchedRule).toBe('rm-rf-home');
    });
  });

  describe('PROTECTED_PATHS', () => {
    it('blocks paths matching .git', () => {
      const result = evaluate('ls /repo/.git/config', { cwd: '/repo' });
      expect(result.decision).toBe(Decision.BLOCK);
      expect(result.matchedRule).toBe('protected-path');
    });

    it('blocks paths matching .env', () => {
      const result = evaluate('cat /repo/.env.local', { cwd: '/repo' });
      expect(result.decision).toBe(Decision.BLOCK);
    });

    it('blocks paths matching .ssh', () => {
      const result = evaluate('cat /home/user/.ssh/id_rsa', { cwd: '/repo' });
      expect(result.decision).toBe(Decision.BLOCK);
    });
  });

  describe('workspace boundary', () => {
    it('allows paths inside workspace by default', () => {
      // find -delete is ASK pattern, matches path inside workspace
      const result = evaluate('find /repo/src -delete', { cwd: '/repo' });
      expect(result.decision).toBe(Decision.ASK); // ASK because of find -delete pattern
      expect(result.matchedRule).toBe('find-delete');
    });

    it('allows paths outside workspace by default', () => {
      // find -delete is ASK pattern, not BLOCK - matches outside workspace
      // The outside-workspace rule has defaultSeverity: 'allow', so paths outside workspace are ALLOWED
      const result = evaluate('find /etc/passwd -delete', { cwd: '/repo' });
      expect(result.decision).toBe(Decision.ALLOW);
      expect(result.matchedRule).toBe('outside-workspace');
    });

    it('blocks paths outside workspace when configured', () => {
      // find -delete is ASK pattern, not BLOCK - matches outside workspace with block config
      const result = evaluate('find /etc/passwd -delete', {
        cwd: '/repo',
        config: { rules: { 'outside-workspace': 'block' } },
      });
      expect(result.decision).toBe(Decision.BLOCK);
      expect(result.matchedRule).toBe('outside-workspace-block');
    });
  });

  describe('ASK patterns', () => {
    it('asks for find with -delete', () => {
      const result = evaluate('find . -name "*.tmp" -delete', { cwd: '/repo' });
      expect(result.decision).toBe(Decision.ASK);
      expect(result.matchedRule).toBe('find-delete');
    });

    it('asks for chmod -R', () => {
      const result = evaluate('chmod -R 755 /path', { cwd: '/repo' });
      expect(result.decision).toBe(Decision.ASK);
      expect(result.matchedRule).toBe('chmod-recursive');
    });

    it('asks for chown -R', () => {
      const result = evaluate('chown -R user:group /path', { cwd: '/repo' });
      expect(result.decision).toBe(Decision.ASK);
      expect(result.matchedRule).toBe('chown-recursive');
    });

    it('asks for sudo', () => {
      const result = evaluate('sudo apt update', { cwd: '/repo' });
      expect(result.decision).toBe(Decision.ASK);
      expect(result.matchedRule).toBe('sudo');
    });

    it('asks for git reset --hard', () => {
      const result = evaluate('git reset --hard', { cwd: '/repo' });
      expect(result.decision).toBe(Decision.ASK);
      expect(result.matchedRule).toBe('git.reset-hard');
    });

    it('asks for git push with force', () => {
      const result = evaluate('git push --force', { cwd: '/repo' });
      expect(result.decision).toBe(Decision.ASK);
      expect(result.matchedRule).toBe('git.push-force');
    });
  });

  describe('ALLOW cases', () => {
    it('allows echo commands', () => {
      const result = evaluate('echo "hello world"', { cwd: '/repo' });
      expect(result.decision).toBe(Decision.ALLOW);
      expect(result.matchedRule).toBe('allow-default');
    });

    it('allows pytest', () => {
      const result = evaluate('pytest', { cwd: '/repo' });
      expect(result.decision).toBe(Decision.ALLOW);
      expect(result.matchedRule).toBe('allow-default');
    });

    it('allows git status', () => {
      const result = evaluate('git status', { cwd: '/repo' });
      expect(result.decision).toBe(Decision.ALLOW);
      expect(result.matchedRule).toBe('allow-default');
    });

    it('allows normal rm (not -rf)', () => {
      const result = evaluate('rm file.txt', { cwd: '/repo' });
      expect(result.decision).toBe(Decision.ALLOW);
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
});
describe('evaluate > sed command edge cases', () => {
  // Test cases: [command, cwd, expectedDecision, expectedRule, description]
  const sedTestCases: [string, string, Decision, string, string][] = [
    // sed substitution patterns should NOT trigger outside-workspace
    ["sed -i '' '/immutable: true/d' /repo/file.txt", '/repo', Decision.ALLOW, 'allow-default', 'sed with delete pattern'],
    ["sed 's/pattern/replacement/g' /repo/file.txt", '/repo', Decision.ALLOW, 'allow-default', 'sed with substitution'],
    ["sed 's/foo/bar/' /repo/file.txt", '/repo', Decision.ALLOW, 'allow-default', 'sed with simple substitution'],
    ["sed '/pattern/d' /repo/file.txt", '/repo', Decision.ALLOW, 'allow-default', 'sed with delete'],
    // grep with regex patterns should NOT trigger outside-workspace
    ["grep -E '/^[a-z]+/g' /repo/file.txt", '/repo', Decision.ALLOW, 'allow-default', 'grep with regex'],
    // Path outside workspace with .. and .env (protected path) should be BLOCKED
    ["cat ../secrets/.env", '/repo', Decision.BLOCK, 'protected-path', 'path with .. escaping and .env (protected)'],
    // Absolute path outside workspace - boundary check matches
    ["cat /etc/passwd", '/repo', Decision.ALLOW, 'outside-workspace', 'absolute path outside workspace (default allow)'],
    // Real paths with directories should work
    ["ls /repo/src/main.ts", '/repo', Decision.ALLOW, 'allow-default', 'real path inside workspace'],
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

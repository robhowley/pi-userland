import { describe, it, expect } from 'vitest';
import { evaluate, evaluateQuick, evaluateQuickResult, Decision, Config } from '../../extensions/yolo-seatbelt/evaluate.ts';
import { BLOCK_PATTERNS, ASK_PATTERNS } from '../../extensions/yolo-seatbelt/patterns.ts';
import { PROTECTED_PATHS } from '../../extensions/yolo-seatbelt/paths.ts';

// Helper to create expected rule names
function expectRule(prefix: string, name: string) {
  return `${prefix}-${name}`;
}

describe('evaluate', () => {
  describe('evaluation order', () => {
    it('BLOCK patterns have highest priority', () => {
      const result = evaluate('rm -rf /some/path', { cwd: '/repo' });
      expect(result.decision).toBe(Decision.BLOCK);
      expect(result.matchedRule).toBe('block-rm-rf-root');
    });

    it('PROTECTED_PATHS check before workspace boundary', () => {
      // ls /repo/.git doesn't match any BLOCK pattern but has protected path
      const result = evaluate('ls /repo/.git/config', { cwd: '/repo' });
      expect(result.decision).toBe(Decision.BLOCK);
      expect(result.matchedRule).toBe('block-protected-path');
    });

    it('workspace boundary check before ASK patterns', () => {
      // find with -delete is ASK pattern, not BLOCK - tests workspace boundary
      const result = evaluate('find /etc/passwd -delete', {
        cwd: '/repo',
        config: { outsideWorkspace: 'block' },
      });
      expect(result.decision).toBe(Decision.BLOCK);
      expect(result.matchedRule).toBe('block-outside-workspace');
    });

    it('ASK patterns checked before default ALLOW', () => {
      const result = evaluate('find . -delete', { cwd: '/repo' });
      expect(result.decision).toBe(Decision.ASK);
      expect(result.matchedRule).toBe('ask-find-delete');
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
      expect(result.message).toBe('Blocked: Command matches forbidden pattern');
    });

    it('blocks rm -rf .git', () => {
      const result = evaluate('rm -rf .git', { cwd: '/repo' });
      expect(result.decision).toBe(Decision.BLOCK);
      expect(result.matchedRule).toBe('block-rm-rf-dot-git');
    });

    it('blocks rm -rf ~', () => {
      const result = evaluate('rm -rf ~', { cwd: '/repo' });
      expect(result.decision).toBe(Decision.BLOCK);
      expect(result.matchedRule).toBe('block-rm-rf-tilde');
    });
  });

  describe('PROTECTED_PATHS', () => {
    it('blocks paths matching .git', () => {
      const result = evaluate('ls /repo/.git/config', { cwd: '/repo' });
      expect(result.decision).toBe(Decision.BLOCK);
      expect(result.matchedRule).toBe('block-protected-path');
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
      expect(result.matchedRule).toBe('ask-find-delete');
    });

    it('asks about paths outside workspace by default', () => {
      // find -delete is ASK pattern, not BLOCK - matches outside workspace
      const result = evaluate('find /etc/passwd -delete', { cwd: '/repo' });
      expect(result.decision).toBe(Decision.ASK);
      expect(result.matchedRule).toBe('ask-outside-workspace');
    });

    it('blocks paths outside workspace when configured', () => {
      // find -delete is ASK pattern, not BLOCK - matches outside workspace with block config
      const result = evaluate('find /etc/passwd -delete', {
        cwd: '/repo',
        config: { outsideWorkspace: 'block' },
      });
      expect(result.decision).toBe(Decision.BLOCK);
      expect(result.matchedRule).toBe('block-outside-workspace');
    });
  });

  describe('ASK patterns', () => {
    it('asks for find with -delete', () => {
      const result = evaluate('find . -name "*.tmp" -delete', { cwd: '/repo' });
      expect(result.decision).toBe(Decision.ASK);
      expect(result.matchedRule).toBe('ask-find-delete');
    });

    it('asks for chmod -R', () => {
      const result = evaluate('chmod -R 755 /path', { cwd: '/repo' });
      expect(result.decision).toBe(Decision.ASK);
    });

    it('asks for chown -R', () => {
      const result = evaluate('chown -R user:group /path', { cwd: '/repo' });
      expect(result.decision).toBe(Decision.ASK);
    });

    it('asks for sudo', () => {
      const result = evaluate('sudo apt update', { cwd: '/repo' });
      expect(result.decision).toBe(Decision.ASK);
    });

    it('asks for git reset --hard', () => {
      const result = evaluate('git reset --hard', { cwd: '/repo' });
      expect(result.decision).toBe(Decision.ASK);
    });

    it('asks for git push with force', () => {
      const result = evaluate('git push --force', { cwd: '/repo' });
      expect(result.decision).toBe(Decision.ASK);
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
    });

    it('allows git status', () => {
      const result = evaluate('git status', { cwd: '/repo' });
      expect(result.decision).toBe(Decision.ALLOW);
    });

    it('allows normal rm (not -rf)', () => {
      const result = evaluate('rm file.txt', { cwd: '/repo' });
      expect(result.decision).toBe(Decision.ALLOW);
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

describe('evaluateQuick', () => {
  it('returns BLOCK for blocked patterns', () => {
    expect(evaluateQuick('rm -rf /')).toBe(Decision.BLOCK);
    expect(evaluateQuick('rm -rf .git')).toBe(Decision.BLOCK);
    expect(evaluateQuick('rm -rf ~')).toBe(Decision.BLOCK);
  });

  it('returns ASK for asked patterns', () => {
    expect(evaluateQuick('find . -delete')).toBe(Decision.ASK);
    expect(evaluateQuick('chmod -R 755 /path')).toBe(Decision.ASK);
    expect(evaluateQuick('git reset --hard')).toBe(Decision.ASK);
  });

  it('returns ALLOW for safe commands', () => {
    expect(evaluateQuick('echo "hello"')).toBe(Decision.ALLOW);
    expect(evaluateQuick('pytest')).toBe(Decision.ALLOW);
    expect(evaluateQuick('git status')).toBe(Decision.ALLOW);
  });
});

describe('evaluateQuickResult', () => {
  it('returns DecisionResult for blocked patterns', () => {
    const result = evaluateQuickResult('rm -rf /');
    expect(result.decision).toBe(Decision.BLOCK);
    expect(result.matchedRule).toBe('block-rm-rf-root');
  });

  it('returns DecisionResult for asked patterns', () => {
    const result = evaluateQuickResult('find . -delete');
    expect(result.decision).toBe(Decision.ASK);
    expect(result.matchedRule).toBe('ask-find-delete');
  });

  it('returns DecisionResult for allowed commands', () => {
    const result = evaluateQuickResult('echo "hello"');
    expect(result.decision).toBe(Decision.ALLOW);
    expect(result.matchedRule).toBe('allow-default');
  });
});

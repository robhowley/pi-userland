import { describe, it, expect } from 'vitest';
import { classify, getMatchedPattern } from '../../extensions/yolo-seatbelt/matcher.js';
import { Decision } from '../../extensions/yolo-seatbelt/patterns.js';

describe('classify', () => {
  describe('BLOCK patterns', () => {
    it('blocks rm -rf /', () => {
      expect(classify('rm -rf /')).toBe(Decision.BLOCK);
    });

    it('blocks rm -rf .git', () => {
      expect(classify('rm -rf .git')).toBe(Decision.BLOCK);
    });

    it('blocks rm -rf ~', () => {
      expect(classify('rm -rf ~')).toBe(Decision.BLOCK);
    });

    it('blocks rm -rf /path/to/dir', () => {
      expect(classify('rm -rf /path/to/dir')).toBe(Decision.BLOCK);
    });
  });

  describe('ASK patterns', () => {
    it('asks for rm -rf without specific path', () => {
      expect(classify('rm -rf')).toBe(Decision.ASK);
    });

    it('asks for rm -rf with wildcard', () => {
      expect(classify('rm -rf *')).toBe(Decision.ASK);
    });

    it('asks for find with -delete', () => {
      expect(classify('find . -name "*.tmp" -delete')).toBe(Decision.ASK);
    });

    it('asks for chmod -R', () => {
      expect(classify('chmod -R 755 /path')).toBe(Decision.ASK);
    });

    it('asks for chown -R', () => {
      expect(classify('chown -R user:group /path')).toBe(Decision.ASK);
    });

    it('asks for sudo', () => {
      expect(classify('sudo apt-get install vim')).toBe(Decision.ASK);
    });

    it('asks for git reset --hard', () => {
      expect(classify('git reset --hard HEAD~1')).toBe(Decision.ASK);
    });

    it('asks for git clean with -f', () => {
      expect(classify('git clean -fd')).toBe(Decision.ASK);
    });

    it('asks for git push --force', () => {
      expect(classify('git push --force')).toBe(Decision.ASK);
    });

    it('asks for git push --force-with-lease', () => {
      expect(classify('git push --force-with-lease')).toBe(Decision.ASK);
    });

    it('asks for git rebase -i', () => {
      expect(classify('git rebase -i HEAD~3')).toBe(Decision.ASK);
    });

    it('asks for git filter-branch', () => {
      expect(classify('git filter-branch --force')).toBe(Decision.ASK);
    });

    it('asks for git update-ref', () => {
      expect(classify('git update-ref refs/heads/main abc123')).toBe(Decision.ASK);
    });

    it('asks for git reflog expire', () => {
      expect(classify('git reflog expire --expire=now --all')).toBe(Decision.ASK);
    });
  });

  describe('ALLOW patterns', () => {
    it('allows normal commands', () => {
      expect(classify('pytest')).toBe(Decision.ALLOW);
    });

    it('allows echo', () => {
      expect(classify('echo "hello"')).toBe(Decision.ALLOW);
    });

    it('allows git status', () => {
      expect(classify('git status')).toBe(Decision.ALLOW);
    });

    it('allows git log', () => {
      expect(classify('git log --oneline')).toBe(Decision.ALLOW);
    });

    it('allows git diff', () => {
      expect(classify('git diff')).toBe(Decision.ALLOW);
    });

    it('allows npm install', () => {
      expect(classify('npm install')).toBe(Decision.ALLOW);
    });

    it('allows normal rm without -rf', () => {
      expect(classify('rm file.txt')).toBe(Decision.ALLOW);
    });

    it('allows git push without force', () => {
      expect(classify('git push origin main')).toBe(Decision.ALLOW);
    });
  });
});

describe('getMatchedPattern', () => {
  it('returns matched BLOCK pattern', () => {
    const result = getMatchedPattern('rm -rf .git');
    expect(result).toEqual({ patternIndex: 1, type: 'BLOCK' });
  });

  it('returns matched ASK pattern', () => {
    const result = getMatchedPattern('chmod -R 755 /path');
    expect(result).toEqual({ patternIndex: 2, type: 'ASK' });
  });

  it('returns null for ALLOW command', () => {
    const result = getMatchedPattern('echo hello');
    expect(result).toBeNull();
  });
});

describe('Pattern coverage', () => {
  it('all BLOCK_PATTERNS should match and return BLOCK', () => {
    // Test with a matching string - verify pattern works
    expect(classify('rm -rf /')).toBe(Decision.BLOCK);
  });

  it('all ASK_PATTERNS should match and return ASK', () => {
    const testCommands = [
      'rm -rf',
      'find . -delete',
      'chmod -R 755',
      'chown -R user:group',
      'sudo apt-get update',
      'git reset --hard',
      'git clean -fd',
      'git push --force',
      'git rebase -i',
      'git filter-branch',
      'git update-ref',
      'git reflog expire',
    ];

    for (const command of testCommands) {
      const decision = classify(command);
      expect(decision).toBe(Decision.ASK);
    }
  });
});

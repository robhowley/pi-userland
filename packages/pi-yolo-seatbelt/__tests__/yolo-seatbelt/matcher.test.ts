import { describe, expect, it } from 'vitest';
import { classify } from '../../extensions/yolo-seatbelt/matcher.js';
import { RuleSeverity } from '../../extensions/yolo-seatbelt/rules.js';

describe('classify', () => {
  describe('BLOCK patterns', () => {
    it('blocks rm -rf /', () => {
      expect(classify('rm -rf /').decision).toBe(RuleSeverity.BLOCK);
    });

    it('blocks rm -rf .git', () => {
      expect(classify('rm -rf .git').decision).toBe(RuleSeverity.BLOCK);
    });

    it('blocks rm -rf ~', () => {
      expect(classify('rm -rf ~').decision).toBe(RuleSeverity.BLOCK);
    });

    it('blocks rm -rf /path/to/dir', () => {
      expect(classify('rm -rf /path/to/dir').decision).toBe(RuleSeverity.BLOCK);
    });
  });

  describe('ASK patterns', () => {
    it('asks for rm -rf without specific path', () => {
      expect(classify('rm -rf').decision).toBe(RuleSeverity.ASK);
    });

    it('asks for rm -rf with wildcard', () => {
      expect(classify('rm -rf *').decision).toBe(RuleSeverity.ASK);
    });

    it('asks for find with -delete', () => {
      expect(classify('find . -name "*.tmp" -delete').decision).toBe(RuleSeverity.ASK);
    });

    it('asks for chmod -R', () => {
      expect(classify('chmod -R 755 /path').decision).toBe(RuleSeverity.ASK);
    });

    it('asks for chown -R', () => {
      expect(classify('chown -R user:group /path').decision).toBe(RuleSeverity.ASK);
    });

    it('asks for sudo', () => {
      expect(classify('sudo apt-get install vim').decision).toBe(RuleSeverity.ASK);
    });

    it('asks for git reset --hard', () => {
      expect(classify('git reset --hard HEAD~1').decision).toBe(RuleSeverity.ASK);
    });

    it('asks for git clean with -f', () => {
      expect(classify('git clean -fd').decision).toBe(RuleSeverity.ASK);
    });

    it('asks for git push --force', () => {
      expect(classify('git push --force').decision).toBe(RuleSeverity.ASK);
    });

    it('asks for git push --force-with-lease', () => {
      expect(classify('git push --force-with-lease').decision).toBe(RuleSeverity.ASK);
    });

    it('asks for git rebase -i', () => {
      expect(classify('git rebase -i HEAD~3').decision).toBe(RuleSeverity.ASK);
    });

    it('asks for git filter-branch', () => {
      expect(classify('git filter-branch --force').decision).toBe(RuleSeverity.ASK);
    });

    it('asks for git update-ref', () => {
      expect(classify('git update-ref refs/heads/main abc123').decision).toBe(RuleSeverity.ASK);
    });

    it('asks for git reflog expire', () => {
      expect(classify('git reflog expire --expire=now --all').decision).toBe(RuleSeverity.ASK);
    });
  });

  describe('ALLOW patterns', () => {
    it('allows normal commands', () => {
      expect(classify('pytest').decision).toBe(RuleSeverity.ALLOW);
    });

    it('allows echo', () => {
      expect(classify('echo "hello"').decision).toBe(RuleSeverity.ALLOW);
    });

    it('allows git status', () => {
      expect(classify('git status').decision).toBe(RuleSeverity.ALLOW);
    });

    it('allows git log', () => {
      expect(classify('git log --oneline').decision).toBe(RuleSeverity.ALLOW);
    });

    it('allows git diff', () => {
      expect(classify('git diff').decision).toBe(RuleSeverity.ALLOW);
    });

    it('allows npm install', () => {
      expect(classify('npm install').decision).toBe(RuleSeverity.ALLOW);
    });

    it('allows normal rm without -rf', () => {
      expect(classify('rm file.txt').decision).toBe(RuleSeverity.ALLOW);
    });

    it('allows git push without force', () => {
      expect(classify('git push origin main').decision).toBe(RuleSeverity.ALLOW);
    });
  });
});


describe('Pattern coverage', () => {
  it('all BLOCK patterns should match and return BLOCK', () => {
    expect(classify('rm -rf /').decision).toBe(RuleSeverity.BLOCK);
  });

  it('all ASK patterns should match and return ASK', () => {
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
      expect(classify(command).decision).toBe(RuleSeverity.ASK);
    }
  });
});

describe('Matching respects config overrides', () => {
  it('all BLOCK patterns should match and return BLOCK', () => {
    expect(classify('rm -rf /', {rules: {'rm-rf': RuleSeverity.ALLOW, 'rm-rf-root': RuleSeverity.ALLOW}}).decision).toBe(RuleSeverity.ALLOW);
    expect(classify('rm -rf /', {rules: {'rm-rf': RuleSeverity.ALLOW, 'rm-rf-root': RuleSeverity.ASK}}).decision).toBe(RuleSeverity.ASK);
  });
});
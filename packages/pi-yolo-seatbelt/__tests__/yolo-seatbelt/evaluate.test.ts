import { describe, it, expect } from 'vitest';
import { evaluate } from '../../extensions/yolo-seatbelt/evaluate.js';
import { RuleSeverity } from '../../extensions/yolo-seatbelt/rules.js';

describe('evaluate', () => {
  describe('BLOCK patterns', () => {
    it('blocks rm -rf /', () => {
      const result = evaluate('rm -rf /');
      expect(result.decision).toBe(RuleSeverity.BLOCK);
      expect(result.message).toBe('BLOCK: rm -rf / would delete the entire filesystem');
    });

    it('blocks rm -rf .git', () => {
      const result = evaluate('rm -rf .git');
      expect(result.decision).toBe(RuleSeverity.BLOCK);
      expect(result.matchedRule).toBe('rm-rf-git');
    });

    it('blocks rm -rf ~', () => {
      const result = evaluate('rm -rf ~');
      expect(result.decision).toBe(RuleSeverity.BLOCK);
      expect(result.matchedRule).toBe('rm-rf-home');
    });
  });

  describe('PROTECTED_PATHS', () => {
    it('blocks paths matching .git', () => {
      const result = evaluate('ls /repo/.git/config');
      expect(result.decision).toBe(RuleSeverity.BLOCK);
      expect(result.matchedRule).toBe('path.git');
    });

    it('blocks paths matching .ssh', () => {
      const result = evaluate('cat /home/user/.ssh/id_rsa');
      expect(result.decision).toBe(RuleSeverity.BLOCK);
    });
  });

  describe('workspace boundary', () => {
    it('asks for find -delete inside workspace', () => {
      // find -delete is ASK pattern, matches path inside workspace
      const result = evaluate('find /repo/src -delete');
      expect(result.decision).toBe(RuleSeverity.ASK);
      expect(result.matchedRule).toBe('find-delete');
    });

    describe('ASK patterns', () => {
      it('asks for find with -delete', () => {
        const result = evaluate('find . -name "*.tmp" -delete');
        expect(result.decision).toBe(RuleSeverity.ASK);
        expect(result.matchedRule).toBe('find-delete');
      });

      it('asks for chmod -R', () => {
        const result = evaluate('chmod -R 755 /path');
        expect(result.decision).toBe(RuleSeverity.ASK);
        expect(result.matchedRule).toBe('chmod-recursive');
      });

      it('asks for chown -R', () => {
        const result = evaluate('chown -R user:group /path');
        expect(result.decision).toBe(RuleSeverity.ASK);
        expect(result.matchedRule).toBe('chown-recursive');
      });

      it('asks for sudo', () => {
        const result = evaluate('sudo apt update');
        expect(result.decision).toBe(RuleSeverity.ASK);
        expect(result.matchedRule).toBe('sudo');
      });

      it('asks for git reset --hard', () => {
        const result = evaluate('git reset --hard');
        expect(result.decision).toBe(RuleSeverity.ASK);
        expect(result.matchedRule).toBe('git.reset-hard');
      });

      it('asks for git push with force', () => {
        const result = evaluate('git push --force');
        expect(result.decision).toBe(RuleSeverity.ASK);
        expect(result.matchedRule).toBe('git.push-force');
      });
    });

    describe('ALLOW cases', () => {
      it('allows echo commands', () => {
        const result = evaluate('echo "hello world"');
        expect(result.decision).toBe(RuleSeverity.ALLOW);
        expect(result.matchedRule).toBe('allow-default');
      });

      it('allows pytest', () => {
        const result = evaluate('pytest');
        expect(result.decision).toBe(RuleSeverity.ALLOW);
        expect(result.matchedRule).toBe('allow-default');
      });

      it('allows git status', () => {
        const result = evaluate('git status');
        expect(result.decision).toBe(RuleSeverity.ALLOW);
        expect(result.matchedRule).toBe('allow-default');
      });

      it('allows normal rm (not -rf)', () => {
        const result = evaluate('rm file.txt');
        expect(result.decision).toBe(RuleSeverity.ALLOW);
        expect(result.matchedRule).toBe('allow-default');
      });
    });

    describe('DecisionResult structure', () => {
      it('includes decision, matchedRule, and message', () => {
        const result = evaluate('rm -rf /');
        expect(result).toHaveProperty('decision');
        expect(result).toHaveProperty('matchedRule');
        expect(result).toHaveProperty('message');
        expect(typeof result.decision).toBe('string');
        expect(typeof result.matchedRule).toBe('string');
        expect(typeof result.message).toBe('string');
      });
    });
  });
});
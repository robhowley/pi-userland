import { describe, it, expect } from 'vitest';
import { isInsideWorkspace, isOutsideWorkspaceQuickCheck } from '../boundary.js';
import * as path from 'path';

describe('isInsideWorkspace', () => {
  describe('within workspace', () => {
    it('detects paths inside workspace', () => {
      const cwd = '/repo';
      expect(isInsideWorkspace('/repo/src', cwd)).toBe(true);
      expect(isInsideWorkspace('/repo/src/main.ts', cwd)).toBe(true);
      expect(isInsideWorkspace('/repo/.git', cwd)).toBe(true);
      expect(isInsideWorkspace('/repo', cwd)).toBe(true);
    });

    it('handles relative paths', () => {
      const cwd = '/repo';
      expect(isInsideWorkspace('src', cwd)).toBe(true);
      expect(isInsideWorkspace('./src', cwd)).toBe(true);
      expect(isInsideWorkspace('src/main.ts', cwd)).toBe(true);
    });

    it('handles nested relative paths', () => {
      const cwd = '/repo';
      expect(isInsideWorkspace('../repo/src', cwd)).toBe(true);
      expect(isInsideWorkspace('../repo/./src', cwd)).toBe(true);
    });

    it('handles multiple directory levels', () => {
      const cwd = '/home/user/project';
      expect(isInsideWorkspace('/home/user/project/src/lib/utils.ts', cwd)).toBe(true);
      expect(isInsideWorkspace('/home/user/project/dist', cwd)).toBe(true);
    });
  });

  describe('outside workspace', () => {
    it('detects paths outside workspace', () => {
      const cwd = '/repo';
      expect(isInsideWorkspace('/etc/passwd', cwd)).toBe(false);
      expect(isInsideWorkspace('/var/log/syslog', cwd)).toBe(false);
      expect(isInsideWorkspace('/usr/bin', cwd)).toBe(false);
      expect(isInsideWorkspace('/home/user/other', cwd)).toBe(false);
    });

    it('handles parent directory references that escape', () => {
      const cwd = '/repo/src';
      expect(isInsideWorkspace('..', cwd)).toBe(false);
      expect(isInsideWorkspace('../', cwd)).toBe(false);
      expect(isInsideWorkspace('../../etc', cwd)).toBe(false);
    });

    it('handles complex relative paths that escape', () => {
      const cwd = '/repo';
      expect(isInsideWorkspace('/etc/passwd', cwd)).toBe(false);
    });
  });

  describe('edge cases', () => {
    it('handles trailing slashes', () => {
      const cwd = '/repo/';
      expect(isInsideWorkspace('/repo', cwd)).toBe(true);
      expect(isInsideWorkspace('/repo/', cwd)).toBe(true);
      expect(isInsideWorkspace('/repo/src', cwd)).toBe(true);
    });

    it('handles . and ./ patterns', () => {
      const cwd = '/repo';
      expect(isInsideWorkspace('.', cwd)).toBe(true);
      expect(isInsideWorkspace('./', cwd)).toBe(true);
      expect(isInsideWorkspace('./src', cwd)).toBe(true);
    });

    it('handles paths with double slashes', () => {
      const cwd = '/repo';
      expect(isInsideWorkspace('/repo//src', cwd)).toBe(true);
    });

    it('handles paths with trailing slashes on cwd', () => {
      const cwd = '/repo/';
      expect(isInsideWorkspace('/repo/src', cwd)).toBe(true);
    });
  });
});

describe('isOutsideWorkspaceQuickCheck', () => {
  describe('outside workspace patterns', () => {
    it('detects absolute paths outside workspace', () => {
      expect(isOutsideWorkspaceQuickCheck('/etc/passwd', '/repo')).toBe(true);
      expect(isOutsideWorkspaceQuickCheck('/var/log', '/repo')).toBe(true);
    });

    it('detects parent directory escapes', () => {
      expect(isOutsideWorkspaceQuickCheck('../', '/repo')).toBe(true);
      expect(isOutsideWorkspaceQuickCheck('../../etc', '/repo')).toBe(true);
      expect(isOutsideWorkspaceQuickCheck('..', '/repo')).toBe(true);
      expect(isOutsideWorkspaceQuickCheck('../src', '/repo')).toBe(true);
    });

    it('detects paths with multiple ../ segments', () => {
      expect(isOutsideWorkspaceQuickCheck('../..', '/repo')).toBe(true);
      expect(isOutsideWorkspaceQuickCheck('../../../etc', '/repo')).toBe(true);
    });

    it('detects paths containing ../', () => {
      expect(isOutsideWorkspaceQuickCheck('foo/../bar', '/repo')).toBe(true);
    });
  });

  describe('inside workspace patterns', () => {
    it('allows relative paths inside workspace', () => {
      expect(isOutsideWorkspaceQuickCheck('src', '/repo')).toBe(false);
      expect(isOutsideWorkspaceQuickCheck('src/main.ts', '/repo')).toBe(false);
      expect(isOutsideWorkspaceQuickCheck('./src', '/repo')).toBe(false);
    });

    it('allows absolute paths inside workspace', () => {
      expect(isOutsideWorkspaceQuickCheck('/repo/src', '/repo')).toBe(false);
      expect(isOutsideWorkspaceQuickCheck('/repo', '/repo')).toBe(false);
    });
  });
});

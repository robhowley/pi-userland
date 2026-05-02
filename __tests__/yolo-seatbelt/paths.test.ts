import { describe, it, expect } from 'vitest';
import { isProtectedPath, isProtectedPathSegment, PROTECTED_PATHS } from '../extensions/yolo-seatbelt/paths.js';

describe('isProtectedPath', () => {
  describe('protected directory patterns', () => {
    it('detects .git directory', () => {
      expect(isProtectedPath('/repo/.git')).toBe(true);
      expect(isProtectedPath('/repo/.git/')).toBe(true);
      expect(isProtectedPath('/repo/.git/config')).toBe(true);
      expect(isProtectedPath('/home/user/.git')).toBe(true);
    });

    it('detects .env files and directories', () => {
      expect(isProtectedPath('/repo/.env')).toBe(true);
      expect(isProtectedPath('/repo/.env.local')).toBe(true);
      expect(isProtectedPath('/repo/.env.production')).toBe(true);
      expect(isProtectedPath('/repo/.env.dev')).toBe(true);
      expect(isProtectedPath('/repo/.env.')).toBe(true);
    });

    it('detects .ssh directory', () => {
      expect(isProtectedPath('/home/user/.ssh')).toBe(true);
      expect(isProtectedPath('/home/user/.ssh/authorized_keys')).toBe(true);
    });

    it('detects .npmrc file', () => {
      expect(isProtectedPath('/home/user/.npmrc')).toBe(true);
      expect(isProtectedPath('/repo/.npmrc')).toBe(true);
    });

    it('detects .pypirc file', () => {
      expect(isProtectedPath('/home/user/.pypirc')).toBe(true);
    });

    it('detects .netrc file', () => {
      expect(isProtectedPath('/home/user/.netrc')).toBe(true);
    });
  });

  describe('credential files', () => {
    it('detects SSH key files', () => {
      expect(isProtectedPath('/home/user/id_rsa')).toBe(true);
      expect(isProtectedPath('/home/user/.ssh/id_rsa')).toBe(true);
      expect(isProtectedPath('/home/user/id_ed25519')).toBe(true);
      expect(isProtectedPath('/home/user/.ssh/id_ed25519')).toBe(true);
    });

    it('detects .pem files', () => {
      expect(isProtectedPath('/home/user/cert.pem')).toBe(true);
      expect(isProtectedPath('/home/user/.ssh/key.pem')).toBe(true);
    });
  });

  describe('non-protected paths', () => {
    it('allows normal source files', () => {
      expect(isProtectedPath('/repo/src/main.ts')).toBe(false);
      expect(isProtectedPath('/repo/lib/utils.js')).toBe(false);
      expect(isProtectedPath('/repo/index.js')).toBe(false);
    });

    it('allows .pytest_cache', () => {
      expect(isProtectedPath('/repo/.pytest_cache')).toBe(false);
      expect(isProtectedPath('/repo/.pytest_cache/v')).toBe(false);
    });

    it('allows regular files with similar names', () => {
      expect(isProtectedPath('/repo/env')).toBe(false);
      expect(isProtectedPath('/repo/envs')).toBe(false);
      expect(isProtectedPath('/repo/git')).toBe(false);
      expect(isProtectedPath('/repo/.gitignore')).toBe(false);
    });

    it('allows paths that contain protected names as substrings', () => {
      expect(isProtectedPath('/repo/my_env')).toBe(false);
      expect(isProtectedPath('/repo/.envBackup')).toBe(false);
      expect(isProtectedPath('/repo/git_repo')).toBe(false);
    });
  });

  describe('path normalization', () => {
    it('handles Windows-style paths', () => {
      expect(isProtectedPath('C:\\repo\\.git')).toBe(true);
      expect(isProtectedPath('C:\\repo\\.env.local')).toBe(true);
    });

    it('handles paths with multiple slashes', () => {
      expect(isProtectedPath('/repo//.git')).toBe(true);
    });

    it('handles paths starting with .', () => {
      expect(isProtectedPath('./.git/config')).toBe(true);
      expect(isProtectedPath('./.env')).toBe(true);
    });
  });
});

describe('isProtectedPathSegment', () => {
  it('detects protected directory names', () => {
    expect(isProtectedPathSegment('.git')).toBe(true);
    expect(isProtectedPathSegment('.env')).toBe(true);
    expect(isProtectedPathSegment('.ssh')).toBe(true);
    expect(isProtectedPathSegment('.npmrc')).toBe(true);
  });

  it('detects credential files', () => {
    expect(isProtectedPathSegment('id_rsa')).toBe(true);
    expect(isProtectedPathSegment('id_ed25519')).toBe(true);
    expect(isProtectedPathSegment('.pem')).toBe(true);
  });

  it('detects .env.* variants', () => {
    expect(isProtectedPathSegment('.env.local')).toBe(true);
    expect(isProtectedPathSegment('.env.production')).toBe(true);
    expect(isProtectedPathSegment('.env.')).toBe(true);
  });

  it('allows normal segments', () => {
    expect(isProtectedPathSegment('src')).toBe(false);
    expect(isProtectedPathSegment('main.ts')).toBe(false);
    expect(isProtectedPathSegment('env')).toBe(false);
    expect(isProtectedPathSegment('.gitignore')).toBe(false);
  });
});

describe('protected path validation', () => {
  it('matches all PROTECTED_PATHS patterns', () => {
    for (const protectedPath of PROTECTED_PATHS) {
      // Test as a directory
      expect(isProtectedPath(`/repo/${protectedPath}`)).toBe(true);
      expect(isProtectedPath(`/repo/${protectedPath}/something`)).toBe(true);
      
      // Test as a file in home directory
      expect(isProtectedPath(`/home/user/${protectedPath}`)).toBe(true);
    }
  });
});

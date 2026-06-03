import { describe, expect, it } from 'vitest';
import {
  assertValidGitHubPullRequestUrl,
  parseGitHubPullRequestUrl,
  validateGitHubPullRequestUrl,
} from '../../extensions/merge-ready/index.js';

describe('merge-ready target parsing', () => {
  it('parses a full GitHub pull request URL', () => {
    expect(parseGitHubPullRequestUrl('https://github.com/owner/repo/pull/64')).toEqual({
      mode: 'url',
      url: 'https://github.com/owner/repo/pull/64',
      owner: 'owner',
      repo: 'repo',
      prNumber: 64,
    });
  });

  it('normalizes a trailing slash on a full GitHub pull request URL', () => {
    expect(assertValidGitHubPullRequestUrl('https://github.com/owner/repo/pull/64/')).toEqual({
      mode: 'url',
      url: 'https://github.com/owner/repo/pull/64',
      owner: 'owner',
      repo: 'repo',
      prNumber: 64,
    });
  });

  it.each([
    '64',
    'branch-name',
    'owner/repo#64',
    'github.com/owner/repo/pull/64',
    'https://github.com/owner/repo/issues/64',
    'https://github.com/owner/repo',
    'https://gitlab.com/owner/repo/-/merge_requests/64',
    'https://github.com/owner/repo/pull/64?foo=bar',
    'https://github.com/owner/repo/pull/64#discussion',
    'https://github.com/owner/repo/pull/64/files',
  ])('rejects invalid explicit target %s', (input) => {
    const validation = validateGitHubPullRequestUrl(input);
    expect(validation.ok).toBe(false);
    expect(parseGitHubPullRequestUrl(input)).toBeNull();
  });
});

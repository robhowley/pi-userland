import type { MergeReadyUrlTarget } from './types.js';

export const MERGE_READY_PULL_REQUEST_URL_EXAMPLE = 'https://github.com/OWNER/REPO/pull/NUMBER';

const GITHUB_PULL_REQUEST_URL_RE =
  /^https:\/\/github\.com\/([^\s/?#]+)\/([^\s/?#]+)\/pull\/([1-9]\d*)\/?$/u;
const INVALID_PULL_REQUEST_URL_MESSAGE = `Pass a full HTTPS GitHub pull request URL like ${MERGE_READY_PULL_REQUEST_URL_EXAMPLE} with no query string, fragment, or extra path.`;

export type MergeReadyUrlValidationResult =
  | {
      ok: true;
      target: MergeReadyUrlTarget;
    }
  | {
      ok: false;
      message: string;
    };

export function parseGitHubPullRequestUrl(url: string): MergeReadyUrlTarget | null {
  const match = GITHUB_PULL_REQUEST_URL_RE.exec(url);
  if (!match) {
    return null;
  }

  const owner = match[1];
  const repo = match[2];
  const pullRequestNumberRaw = match[3];
  if (!owner || !repo || !pullRequestNumberRaw) {
    return null;
  }

  const pullRequestNumber = Number(pullRequestNumberRaw);
  if (!Number.isSafeInteger(pullRequestNumber)) {
    return null;
  }

  return {
    mode: 'url',
    url: `https://github.com/${owner}/${repo}/pull/${String(pullRequestNumber)}`,
    owner,
    repo,
    prNumber: pullRequestNumber,
  };
}

export function assertValidGitHubPullRequestUrl(url: string): MergeReadyUrlTarget {
  const target = parseGitHubPullRequestUrl(url);
  if (!target) {
    throw new Error(INVALID_PULL_REQUEST_URL_MESSAGE);
  }

  return target;
}

export function validateGitHubPullRequestUrl(url: string): MergeReadyUrlValidationResult {
  const target = parseGitHubPullRequestUrl(url);
  return target ? { ok: true, target } : { ok: false, message: INVALID_PULL_REQUEST_URL_MESSAGE };
}

export function formatMergeReadyUrlTarget(target: MergeReadyUrlTarget): string {
  return `${target.owner}/${target.repo}#${String(target.prNumber)}`;
}

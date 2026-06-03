import type { MergeReadyUrlTarget } from './types.js';

export const MERGE_READY_PULL_REQUEST_URL_EXAMPLE = 'https://github.com/OWNER/REPO/pull/NUMBER';

const BRANCH_OR_SHORTHAND_RE = /^[A-Za-z0-9._/-]+(?:#[0-9]+)?$/u;

export type MergeReadyUrlValidationCode =
  | 'pull_request_number'
  | 'branch_or_shorthand'
  | 'malformed_url'
  | 'non_https_url'
  | 'non_github_host'
  | 'issue_url'
  | 'unsupported_github_url';

export type MergeReadyUrlValidationResult =
  | {
      ok: true;
      target: MergeReadyUrlTarget;
    }
  | {
      ok: false;
      code: MergeReadyUrlValidationCode;
      message: string;
    };

export class MergeReadyTargetValidationError extends Error {
  code: MergeReadyUrlValidationCode;
  input: string;

  constructor(input: string, code: MergeReadyUrlValidationCode, message: string) {
    super(message);
    this.name = 'MergeReadyTargetValidationError';
    this.input = input;
    this.code = code;
  }
}

export function parseGitHubPullRequestUrl(url: string): MergeReadyUrlTarget | null {
  const validation = validateGitHubPullRequestUrl(url);
  return validation.ok ? validation.target : null;
}

export function assertValidGitHubPullRequestUrl(url: string): MergeReadyUrlTarget {
  const validation = validateGitHubPullRequestUrl(url);
  if (validation.ok) {
    return validation.target;
  }

  throw new MergeReadyTargetValidationError(url, validation.code, validation.message);
}

export function validateGitHubPullRequestUrl(url: string): MergeReadyUrlValidationResult {
  const trimmedUrl = url.trim();

  if (/^\d+$/u.test(trimmedUrl)) {
    return {
      ok: false,
      code: 'pull_request_number',
      message: `Pull request numbers are not accepted. Pass a full GitHub pull request URL like ${MERGE_READY_PULL_REQUEST_URL_EXAMPLE}.`,
    };
  }

  if (trimmedUrl.startsWith('github.com/')) {
    return {
      ok: false,
      code: 'malformed_url',
      message: `GitHub pull request URLs must start with ${MERGE_READY_PULL_REQUEST_URL_EXAMPLE}.`,
    };
  }

  if (!trimmedUrl.includes('://') && BRANCH_OR_SHORTHAND_RE.test(trimmedUrl)) {
    return {
      ok: false,
      code: 'branch_or_shorthand',
      message: `Branch names, repo names, and PR shorthands are not accepted. Pass a full GitHub pull request URL like ${MERGE_READY_PULL_REQUEST_URL_EXAMPLE}.`,
    };
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(trimmedUrl);
  } catch {
    return {
      ok: false,
      code: 'malformed_url',
      message: `GitHub pull request URLs must match ${MERGE_READY_PULL_REQUEST_URL_EXAMPLE}.`,
    };
  }

  if (parsedUrl.protocol !== 'https:') {
    return {
      ok: false,
      code: 'non_https_url',
      message: 'Only HTTPS GitHub pull request URLs are supported.',
    };
  }

  if (parsedUrl.hostname !== 'github.com') {
    return {
      ok: false,
      code: 'non_github_host',
      message: 'Only github.com pull request URLs are supported.',
    };
  }

  const pathSegments = parsedUrl.pathname.split('/').filter((segment) => segment.length > 0);
  const [owner, repo, resource, pullRequestNumberRaw] = pathSegments;

  if (resource === 'issues') {
    return {
      ok: false,
      code: 'issue_url',
      message: `Issue URLs are not supported. Pass a pull request URL like ${MERGE_READY_PULL_REQUEST_URL_EXAMPLE}.`,
    };
  }

  if (
    parsedUrl.search.length > 0 ||
    parsedUrl.hash.length > 0 ||
    pathSegments.length !== 4 ||
    !owner ||
    !repo ||
    resource !== 'pull'
  ) {
    return {
      ok: false,
      code: 'unsupported_github_url',
      message: `GitHub pull request URLs must match ${MERGE_READY_PULL_REQUEST_URL_EXAMPLE} with no query string, fragment, or extra path.`,
    };
  }

  const pullRequestNumber = parsePullRequestNumber(pullRequestNumberRaw);
  if (pullRequestNumber === null) {
    return {
      ok: false,
      code: 'unsupported_github_url',
      message: `GitHub pull request URLs must match ${MERGE_READY_PULL_REQUEST_URL_EXAMPLE}.`,
    };
  }

  return {
    ok: true,
    target: {
      mode: 'url',
      url: `https://github.com/${owner}/${repo}/pull/${String(pullRequestNumber)}`,
      owner,
      repo,
      prNumber: pullRequestNumber,
    },
  };
}

export function formatMergeReadyUrlTarget(target: MergeReadyUrlTarget): string {
  return `${target.owner}/${target.repo}#${String(target.prNumber)}`;
}

function parsePullRequestNumber(value: string | undefined): number | null {
  if (!value || !/^\d+$/u.test(value)) {
    return null;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

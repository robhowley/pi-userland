#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SHA_PATTERN = /^[0-9a-f]{40}$/i;
const ZERO_SHA = '0'.repeat(40);

// A PR selects desktop work only when a changed path matches this list.
const DESKTOP_PREFIXES = [
  'apps/session-deck-desktop/',
  'packages/pi-session-deck/extensions/',
  '.github/workflows/',
];
const DESKTOP_PATHS = new Set([
  'packages/pi-session-deck/package.json',
  'packages/pi-session-deck/tsconfig.json',
  'packages/pi-session-deck/tsconfig.build.json',
  '.github/scripts/session-deck-ci-classifier.mjs',
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'tsconfig.base.json',
  'eslint.config.js',
  '.prettierrc',
  '.prettierignore',
]);

function decodeUtf8(value, label) {
  if (typeof value === 'string') return value;
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value ?? '');
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) {
    throw new Error(`${label} is not valid UTF-8`, { cause: error });
  }
}

function gitStdout(result) {
  if (result && typeof result === 'object' && 'stdout' in result) return result.stdout;
  return result;
}

function requireSha(value, label) {
  if (typeof value !== 'string' || !SHA_PATTERN.test(value) || value === ZERO_SHA) {
    throw new Error(`${label} must be a nonzero 40-character hexadecimal SHA`);
  }
  return value.toLowerCase();
}

function requirePullNumber(value) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error('pull request number must be a positive integer');
  }
  return value;
}

function requireBranchRef(value) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 255 ||
    value.startsWith('-') ||
    value.startsWith('/') ||
    value.endsWith('/') ||
    value.endsWith('.') ||
    value.includes('..') ||
    value.includes('@{') ||
    /[\0-\x20~^:?*\\[]/.test(value) ||
    value.split('/').some((part) => !part || part.startsWith('.') || part.endsWith('.lock'))
  ) {
    throw new Error('pull request base ref is not a safe Git branch ref');
  }
  return value;
}

async function verifyCommit(sha, git) {
  await git(['rev-parse', '--verify', `${sha}^{commit}`]);
}

/** Resolve event SHAs and return the safe merge-base-to-head PR range. */
export async function resolvePullRequestRange(event, git) {
  if (!event || typeof event !== 'object' || !event.pull_request) {
    throw new Error('pull_request event data is required');
  }
  if (typeof git !== 'function') throw new TypeError('git must be a function');

  const pull = event.pull_request;
  const base = requireSha(pull.base?.sha, 'pull request base SHA');
  const head = requireSha(pull.head?.sha, 'pull request head SHA');
  const number = requirePullNumber(event.number);
  const baseRef = requireBranchRef(pull.base?.ref);

  try {
    await Promise.all([verifyCommit(base, git), verifyCommit(head, git)]);
  } catch {
    await git([
      'fetch',
      '--no-tags',
      'origin',
      `+refs/heads/${baseRef}:refs/remotes/origin/${baseRef}`,
      `+refs/pull/${number}/head:refs/remotes/pull/${number}/head`,
    ]);
    await verifyCommit(base, git);
    await verifyCommit(head, git);
  }

  const mergeBase = decodeUtf8(
    gitStdout(await git(['merge-base', base, head])),
    'git merge-base output',
  ).trim();
  if (!SHA_PATTERN.test(mergeBase) || mergeBase === ZERO_SHA) {
    throw new Error('git merge-base did not return one valid commit SHA');
  }

  return { base, head, mergeBase: mergeBase.toLowerCase() };
}

function validateRepositoryPath(repositoryPath) {
  if (
    typeof repositoryPath !== 'string' ||
    repositoryPath.length === 0 ||
    repositoryPath.includes('\0') ||
    repositoryPath.startsWith('/') ||
    repositoryPath.startsWith('\\') ||
    /^[A-Za-z]:[\\/]/.test(repositoryPath) ||
    repositoryPath.includes('\\') ||
    repositoryPath.split('/').some((part) => part === '' || part === '.' || part === '..')
  ) {
    throw new Error(`unsafe repository path: ${JSON.stringify(repositoryPath)}`);
  }
  return repositoryPath;
}

/** Read Git's strict NUL-delimited path stream. --no-renames exposes both rename sides. */
export async function readChangedPaths(mergeBase, head, git) {
  const validMergeBase = requireSha(mergeBase, 'merge base');
  const validHead = requireSha(head, 'head SHA');
  if (typeof git !== 'function') throw new TypeError('git must be a function');

  const raw = gitStdout(
    await git(['diff', '--name-only', '-z', '--no-renames', validMergeBase, validHead, '--']),
  );
  const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(raw ?? '');
  if (bytes.length === 0) return [];

  const text = decodeUtf8(bytes, 'git diff output');
  if (!text.endsWith('\0')) throw new Error('truncated NUL-delimited git diff output');
  return text.slice(0, -1).split('\0').map(validateRepositoryPath);
}

function parseJsonObject(value, label) {
  const text = decodeUtf8(value, label);
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} is not valid JSON`, { cause: error });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${label} must contain a JSON object`);
  }
  return parsed;
}

function selectsDesktop(repositoryPath) {
  return (
    DESKTOP_PATHS.has(repositoryPath) ||
    DESKTOP_PREFIXES.some((prefix) => repositoryPath.startsWith(prefix))
  );
}

/** Classify validated changed paths without filesystem or manifest inspection. */
export function classify(changedPaths) {
  if (!Array.isArray(changedPaths)) throw new TypeError('changedPaths must be an array');
  return {
    run_desktop: changedPaths.map(validateRepositoryPath).some(selectsDesktop),
    classification_error: false,
  };
}

function runGit(args) {
  return execFileSync('git', args, {
    encoding: null,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function writeOutputs(outputs) {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) throw new Error('GITHUB_OUTPUT is not set');
  const lines = Object.entries(outputs).map(([name, value]) => {
    if (value !== true && value !== false) throw new Error(`invalid output value for ${name}`);
    return `${name}=${value}\n`;
  });
  appendFileSync(outputPath, lines.join(''), 'utf8');
}

async function main() {
  if (process.env.GITHUB_EVENT_NAME !== 'pull_request') {
    writeOutputs({ run_desktop: true, classification_error: false });
    return;
  }

  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath) throw new Error('GITHUB_EVENT_PATH is not set for pull_request');
  const event = parseJsonObject(readFileSync(eventPath), 'GitHub event file');
  const { head, mergeBase } = await resolvePullRequestRange(event, runGit);
  writeOutputs(classify(await readChangedPaths(mergeBase, head, runGit)));
}

const isEntryPoint =
  process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isEntryPoint) {
  main().catch((error) => {
    try {
      writeOutputs({ run_desktop: true, classification_error: true });
    } catch (outputError) {
      console.error(`Session Deck CI classifier output error: ${outputError.message}`);
    }
    console.error(`Session Deck CI classifier error: ${error?.stack ?? error}`);
    process.exitCode = 1;
  });
}

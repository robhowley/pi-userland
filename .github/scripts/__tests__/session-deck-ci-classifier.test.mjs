import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  classify,
  readChangedPaths,
  resolvePullRequestRange,
} from '../session-deck-ci-classifier.mjs';

const SCRIPT = fileURLToPath(new URL('../session-deck-ci-classifier.mjs', import.meta.url));
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const SHA_C = 'c'.repeat(40);

function git(cwd, args, options = {}) {
  return execFileSync('git', ['-c', 'core.fsmonitor=false', ...args], {
    cwd,
    encoding: options.encoding ?? 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function initRepository() {
  const cwd = mkdtempSync(path.join(tmpdir(), 'session-deck-classifier-'));
  // Every fixture Git process disables inherited fsmonitor without replacing normal Git config.
  git(cwd, ['init', '-q', '-b', 'main']);
  git(cwd, ['config', 'user.email', 'ci@example.test']);
  git(cwd, ['config', 'user.name', 'CI Test']);
  return cwd;
}

function commitFile(cwd, repositoryPath, contents, message) {
  const absolutePath = path.join(cwd, repositoryPath);
  mkdirSync(path.dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, contents);
  git(cwd, ['add', '--', repositoryPath]);
  git(cwd, ['commit', '-q', '-m', message]);
  return git(cwd, ['rev-parse', 'HEAD']).trim();
}

function event(base, head, extra = {}) {
  return {
    number: 42,
    pull_request: {
      base: { sha: base, ref: 'main' },
      head: { sha: head },
    },
    ...extra,
  };
}

function runClassifier(cwd, env) {
  return spawnSync(process.execPath, [SCRIPT], {
    cwd,
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
}

function diffBuffer(...paths) {
  return Buffer.from(`${paths.join('\0')}\0`);
}

const positivePaths = [
  ['desktop app subtree', 'apps/session-deck-desktop/web/session-deck-ui.js'],
  ['Session Deck extension subtree', 'packages/pi-session-deck/extensions/session-deck/index.ts'],
  ['Session Deck package manifest', 'packages/pi-session-deck/package.json'],
  ['Session Deck TypeScript config', 'packages/pi-session-deck/tsconfig.json'],
  ['Session Deck build config', 'packages/pi-session-deck/tsconfig.build.json'],
  ['workflow subtree', '.github/workflows/ci.yml'],
  ['classifier itself', '.github/scripts/session-deck-ci-classifier.mjs'],
  ['root package manifest', 'package.json'],
  ['lockfile', 'pnpm-lock.yaml'],
  ['workspace config', 'pnpm-workspace.yaml'],
  ['base TypeScript config', 'tsconfig.base.json'],
  ['ESLint config', 'eslint.config.js'],
  ['Prettier config', '.prettierrc'],
  ['Prettier ignore', '.prettierignore'],
];

test('the positive inclusion list selects every trigger category', () => {
  for (const [name, repositoryPath] of positivePaths) {
    assert.deepEqual(
      classify([repositoryPath]),
      { run_desktop: true, classification_error: false },
      name,
    );
  }
});

test('all included package.json paths select without semantic inspection', () => {
  for (const repositoryPath of [
    'package.json',
    'packages/pi-session-deck/package.json',
    'apps/session-deck-desktop/package.json',
  ]) {
    assert.equal(classify([repositoryPath]).run_desktop, true, repositoryPath);
  }
});

test('explicit non-trigger categories do not select desktop by themselves', () => {
  const nonTriggerPaths = [
    'README.md',
    'packages/pi-session-deck/README.md',
    'packages/pi-session-deck/CHANGELOG.md',
    'packages/pi-session-deck/.npmignore',
    'packages/pi-session-deck/img/screenshot.png',
    'packages/pi-session-deck/__tests__/extension.test.ts',
    'packages/pi-session-deck/src/helper.ts',
    'packages/pi-openrouter/package.json',
    'packages/pi-structured-return/src/index.ts',
    'site/index.html',
    '.agents/skills/example/SKILL.md',
    '.github/scripts/unrelated-script.mjs',
    'scripts/root-tool.mjs',
  ];
  for (const repositoryPath of nonTriggerPaths) {
    assert.deepEqual(
      classify([repositoryPath]),
      { run_desktop: false, classification_error: false },
      repositoryPath,
    );
  }
});

test('empty and mixed diffs OR the positive path results', () => {
  assert.deepEqual(classify([]), { run_desktop: false, classification_error: false });
  assert.deepEqual(classify(['site/index.html', 'pnpm-lock.yaml']), {
    run_desktop: true,
    classification_error: false,
  });
});

test('classify rejects malformed paths supplied by callers', () => {
  assert.throws(() => classify('README.md'), /array/);
  for (const repositoryPath of [
    '',
    '/tmp/file',
    'C:\\tmp\\file',
    'safe\\file',
    'safe/../outside',
    'safe/./file',
    'safe//file',
    'bad\0path',
  ]) {
    assert.throws(() => classify([repositoryPath]), /unsafe repository path/, repositoryPath);
  }
});

test('resolvePullRequestRange uses the merge base when the base branch advanced', async () => {
  const cwd = initRepository();
  const branchPoint = commitFile(cwd, 'common.txt', 'base\n', 'base');
  git(cwd, ['checkout', '-q', '-b', 'feature']);
  commitFile(cwd, 'feature-one.txt', 'one\n', 'feature one');
  const head = commitFile(cwd, 'feature-two.txt', 'two\n', 'feature two');
  git(cwd, ['checkout', '-q', 'main']);
  const base = commitFile(cwd, 'main-only.txt', 'main\n', 'advance main');

  const calls = [];
  const run = async (args) => {
    calls.push(args);
    return git(cwd, args, { encoding: null });
  };
  const range = await resolvePullRequestRange(event(base, head), run);
  assert.deepEqual(range, { base, head, mergeBase: branchPoint });
  assert.equal(
    calls.some(([command]) => command === 'fetch'),
    false,
  );

  const paths = await readChangedPaths(range.mergeBase, range.head, run);
  assert.deepEqual(paths, ['feature-one.txt', 'feature-two.txt']);
});

test('resolvePullRequestRange fetches explicit refs and re-verifies missing commits', async () => {
  let verifyAttempts = 0;
  const calls = [];
  const run = async (args) => {
    calls.push(args);
    if (args[0] === 'rev-parse' && verifyAttempts++ < 2) throw new Error('missing');
    if (args[0] === 'merge-base') return `${SHA_C}\n`;
    return '';
  };

  assert.deepEqual(await resolvePullRequestRange(event(SHA_A, SHA_B), run), {
    base: SHA_A,
    head: SHA_B,
    mergeBase: SHA_C,
  });
  assert.deepEqual(
    calls.find(([command]) => command === 'fetch'),
    [
      'fetch',
      '--no-tags',
      'origin',
      '+refs/heads/main:refs/remotes/origin/main',
      '+refs/pull/42/head:refs/remotes/pull/42/head',
    ],
  );
  assert.equal(calls.filter(([command]) => command === 'rev-parse').length, 4);
});

for (const [name, mutate, message] of [
  ['missing SHA', (value) => delete value.pull_request.base.sha, /base SHA/],
  ['short SHA', (value) => (value.pull_request.head.sha = 'abc123'), /head SHA/],
  ['zero SHA', (value) => (value.pull_request.base.sha = '0'.repeat(40)), /base SHA/],
  ['invalid PR number', (value) => (value.number = '42'), /positive integer/],
  [
    'unsafe base ref',
    (value) => (value.pull_request.base.ref = '--upload-pack=bad'),
    /safe Git branch/,
  ],
]) {
  test(`resolvePullRequestRange rejects ${name}`, async () => {
    const value = event(SHA_A, SHA_B);
    mutate(value);
    await assert.rejects(
      resolvePullRequestRange(value, async () => ''),
      message,
    );
  });
}

test('resolvePullRequestRange accepts uppercase SHAs and normalizes its result', async () => {
  const calls = [];
  const result = await resolvePullRequestRange(
    event(SHA_A.toUpperCase(), SHA_B.toUpperCase()),
    async (args) => {
      calls.push(args);
      return args[0] === 'merge-base' ? SHA_C.toUpperCase() : '';
    },
  );
  assert.deepEqual(result, { base: SHA_A, head: SHA_B, mergeBase: SHA_C });
  assert.equal(calls[0][2], `${SHA_A}^{commit}`);
});

test('resolvePullRequestRange fails on fetch errors and invalid merge bases', async (t) => {
  await t.test('fetch failure', async () => {
    await assert.rejects(
      resolvePullRequestRange(event(SHA_A, SHA_B), async (args) => {
        if (args[0] === 'rev-parse' || args[0] === 'fetch') throw new Error('network unavailable');
        return '';
      }),
      /network unavailable/,
    );
  });
  for (const [name, output] of [
    ['empty', ''],
    ['multiple', `${SHA_C}\n${SHA_A}\n`],
    ['invalid UTF-8', Buffer.from([0xff])],
  ]) {
    await t.test(`${name} merge base`, async () => {
      await assert.rejects(
        resolvePullRequestRange(event(SHA_A, SHA_B), async (args) =>
          args[0] === 'merge-base' ? output : '',
        ),
        /merge-base|UTF-8/,
      );
    });
  }
});

test('readChangedPaths requests a no-renames NUL path stream', async () => {
  const calls = [];
  const paths = await readChangedPaths(SHA_A, SHA_B, async (args) => {
    calls.push(args);
    return diffBuffer('ordinary.txt', 'file with spaces.txt', 'tab\tname.txt');
  });
  assert.deepEqual(paths, ['ordinary.txt', 'file with spaces.txt', 'tab\tname.txt']);
  assert.deepEqual(calls[0], ['diff', '--name-only', '-z', '--no-renames', SHA_A, SHA_B, '--']);
});

test('readChangedPaths handles an empty diff', async () => {
  assert.deepEqual(await readChangedPaths(SHA_A, SHA_B, async () => Buffer.alloc(0)), []);
});

for (const [name, output, message] of [
  ['missing final NUL', Buffer.from('file.txt'), /truncated NUL/],
  ['empty path', diffBuffer('file.txt', ''), /unsafe repository path/],
  ['absolute path', diffBuffer('/tmp/file'), /unsafe repository path/],
  ['drive path', diffBuffer('C:\\tmp\\file'), /unsafe repository path/],
  ['backslash path', diffBuffer('safe\\file'), /unsafe repository path/],
  ['traversal path', diffBuffer('safe/../outside'), /unsafe repository path/],
  ['dot path', diffBuffer('safe/./file'), /unsafe repository path/],
]) {
  test(`readChangedPaths rejects ${name}`, async () => {
    await assert.rejects(
      readChangedPaths(SHA_A, SHA_B, async () => output),
      message,
    );
  });
}

test('readChangedPaths rejects invalid UTF-8', async () => {
  const output = Buffer.concat([Buffer.from('bad-'), Buffer.from([0xff]), Buffer.from('\0')]);
  await assert.rejects(
    readChangedPaths(SHA_A, SHA_B, async () => output),
    /not valid UTF-8/,
  );
});

test('rename movement into and out of trigger paths exposes both sides and selects desktop', async (t) => {
  for (const [name, oldPath, newPath] of [
    [
      'into trigger scope',
      'packages/pi-session-deck/README.md',
      'packages/pi-session-deck/extensions/moved.ts',
    ],
    [
      'out of trigger scope',
      'packages/pi-session-deck/extensions/old.ts',
      'packages/pi-session-deck/img/moved.ts',
    ],
  ]) {
    await t.test(name, async () => {
      const cwd = initRepository();
      const base = commitFile(cwd, oldPath, 'same contents\n', 'base');
      mkdirSync(path.dirname(path.join(cwd, newPath)), { recursive: true });
      git(cwd, ['mv', '--', oldPath, newPath]);
      git(cwd, ['commit', '-q', '-m', 'rename']);
      const head = git(cwd, ['rev-parse', 'HEAD']).trim();
      const paths = await readChangedPaths(base, head, async (args) =>
        git(cwd, args, { encoding: null }),
      );
      assert.deepEqual(new Set(paths), new Set([oldPath, newPath]));
      assert.equal(classify(paths).run_desktop, true);
    });
  }
});

test('non-PR execution writes full selection without reading an event or invoking Git', () => {
  const cwd = mkdtempSync(path.join(tmpdir(), 'session-deck-non-pr-'));
  const bin = path.join(cwd, 'bin');
  mkdirSync(bin);
  writeFileSync(path.join(bin, 'git'), '#!/bin/sh\necho invoked > git-was-invoked\nexit 99\n', {
    mode: 0o755,
  });
  const output = path.join(cwd, 'github-output');
  const result = runClassifier(cwd, {
    GITHUB_EVENT_NAME: 'push',
    GITHUB_EVENT_PATH: path.join(cwd, 'does-not-exist.json'),
    GITHUB_OUTPUT: output,
    PATH: `${bin}:${process.env.PATH}`,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(output, 'utf8'), 'run_desktop=true\nclassification_error=false\n');
  assert.throws(() => readFileSync(path.join(cwd, 'git-was-invoked')), /ENOENT/);
});

test('PR-shaped execution diffs merge base to head and writes its positive decision', () => {
  const cwd = initRepository();
  const base = commitFile(cwd, 'README.md', 'base\n', 'base');
  git(cwd, ['checkout', '-q', '-b', 'feature']);
  const head = commitFile(cwd, 'pnpm-lock.yaml', 'changed\n', 'trigger');
  const eventPath = path.join(cwd, 'event.json');
  writeFileSync(eventPath, JSON.stringify(event(base, head)));
  const output = path.join(cwd, 'github-output');
  const result = runClassifier(cwd, {
    GITHUB_EVENT_NAME: 'pull_request',
    GITHUB_EVENT_PATH: eventPath,
    GITHUB_OUTPUT: output,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(output, 'utf8'), 'run_desktop=true\nclassification_error=false\n');
});

test('malformed PR event emits fail-closed outputs and exits nonzero', () => {
  const cwd = mkdtempSync(path.join(tmpdir(), 'session-deck-error-'));
  const eventPath = path.join(cwd, 'event.json');
  writeFileSync(eventPath, JSON.stringify(event('bad', SHA_B)));
  const output = path.join(cwd, 'github-output');
  const result = runClassifier(cwd, {
    GITHUB_EVENT_NAME: 'pull_request',
    GITHUB_EVENT_PATH: eventPath,
    GITHUB_OUTPUT: output,
  });
  assert.notEqual(result.status, 0);
  assert.equal(readFileSync(output, 'utf8'), 'run_desktop=true\nclassification_error=true\n');
  assert.match(result.stderr, /Session Deck CI classifier error:.*base SHA/s);
});

test('output-write failure is reported and exits nonzero', () => {
  const cwd = mkdtempSync(path.join(tmpdir(), 'session-deck-output-error-'));
  const outputDirectory = path.join(cwd, 'not-a-file');
  mkdirSync(outputDirectory);
  const result = runClassifier(cwd, {
    GITHUB_EVENT_NAME: 'push',
    GITHUB_OUTPUT: outputDirectory,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /classifier output error/);
  assert.match(result.stderr, /classifier error/);
});

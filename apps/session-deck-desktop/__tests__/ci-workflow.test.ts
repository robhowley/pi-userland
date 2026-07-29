import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const WORKFLOWS_ROOT = new URL('../../../.github/workflows/', import.meta.url);
const packageWorkflow = readFileSync(new URL('ci.yml', WORKFLOWS_ROOT), 'utf8');
const desktopWorkflow = readFileSync(new URL('session-deck-desktop.yml', WORKFLOWS_ROOT), 'utf8');
const workflowFiles = readdirSync(WORKFLOWS_ROOT).filter(
  (file) => file.endsWith('.yml') || file.endsWith('.yaml'),
);

const desktopPullRequestPaths = [
  'apps/session-deck-desktop/**',
  'packages/pi-session-deck/extensions/**',
  'packages/pi-session-deck/package.json',
  'packages/pi-session-deck/tsconfig*.json',
  '.github/workflows/**',
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'tsconfig.base.json',
  'eslint.config.js',
  '.prettierrc',
  '.prettierignore',
];

function triggerSection(source: string): string {
  const start = source.indexOf('on:\n');
  const end = source.indexOf('\n\npermissions:', start);
  if (start < 0 || end < 0) throw new Error('Workflow trigger section is missing');
  return source.slice(start, end);
}

function pullRequestPaths(source: string): string[] {
  const trigger = triggerSection(source);
  const start = trigger.indexOf('  pull_request:');
  if (start < 0) return [];

  return [...trigger.slice(start).matchAll(/^ {6}- (.+)$/gmu)].map((match) => {
    const path = match[1];
    if (!path) throw new Error('Empty workflow path filter');
    return path;
  });
}

function jobBlocks(source: string): Map<string, string> {
  const jobsStart = source.indexOf('\njobs:\n');
  if (jobsStart < 0) throw new Error('Workflow jobs are missing');

  const body = source.slice(jobsStart + '\njobs:\n'.length);
  const matches = [...body.matchAll(/^ {2}([a-z][a-z0-9-]*):\n/gmu)];
  return new Map(
    matches.map((match, index) => {
      const name = match[1];
      if (!name || match.index === undefined) throw new Error('Malformed workflow job');
      const nextStart = matches[index + 1]?.index;
      return [name, body.slice(match.index, nextStart)] as const;
    }),
  );
}

function job(source: string, name: string): string {
  const block = jobBlocks(source).get(name);
  if (!block) throw new Error(`Missing workflow job: ${name}`);
  return block;
}

function expectCommandsInOrder(source: string, commands: string[]): void {
  const positions = commands.map((command) => source.indexOf(command));
  expect(
    positions.every(
      (position, index) =>
        position >= 0 && (index === 0 || position > (positions[index - 1] ?? -1)),
    ),
  ).toBe(true);
}

function concurrencyGroup(source: string): string {
  const match = source.match(/^ {2}group: (.+)$/mu);
  if (!match?.[1]) throw new Error('Workflow concurrency group is missing');
  return match[1];
}

function expectSafeConcurrency(source: string, prefix: string): void {
  const group = concurrencyGroup(source);
  expect(group.startsWith(`${prefix}-`)).toBe(true);
  expect(group).toContain("github.event_name == 'pull_request'");
  expect(group).toContain('github.run_id');
  expect(group).toContain('github.run_attempt');
  expect(source).toContain("  cancel-in-progress: ${{ github.event_name == 'pull_request' }}");
}

function matchesGlob(repositoryPath: string, pattern: string): boolean {
  let expression = '';
  for (let index = 0; index < pattern.length; ) {
    if (pattern.startsWith('**', index)) {
      expression += '.*';
      index += 2;
    } else if (pattern[index] === '*') {
      expression += '[^/]*';
      index += 1;
    } else {
      expression += pattern[index]!.replace(/[\\^$+?.()|[\]{}]/g, '\\$&');
      index += 1;
    }
  }
  return new RegExp(`^${expression}$`).test(repositoryPath);
}

function startsDesktopForPath(repositoryPath: string): boolean {
  return desktopPullRequestPaths.some((pattern) => matchesGlob(repositoryPath, pattern));
}

const desktopChecksJob = job(desktopWorkflow, 'desktop-checks');
const desktopTestsJob = job(desktopWorkflow, 'desktop-tests');
const packageChecksJob = job(packageWorkflow, 'package-checks');
const packageTestsJob = job(packageWorkflow, 'package-tests');

const forbiddenSelectionLogic =
  /classifier|classification_error|run_desktop|ci[- ]gate|changed-files|paths-filter|github-script|octokit|api\.github\.com/iu;

const positivePaths = [
  'apps/session-deck-desktop/web/session-deck-ui.js',
  'packages/pi-session-deck/extensions/session-deck/index.ts',
  'packages/pi-session-deck/package.json',
  'packages/pi-session-deck/tsconfig.build.json',
  '.github/workflows/ci.yml',
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'tsconfig.base.json',
  'eslint.config.js',
  '.prettierrc',
  '.prettierignore',
];

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

describe('Session Deck CI workflow contract', () => {
  it('separates package and desktop responsibilities', () => {
    expect([...jobBlocks(packageWorkflow).keys()]).toEqual(['package-checks', 'package-tests']);
    expect([...jobBlocks(desktopWorkflow).keys()]).toEqual(['desktop-checks', 'desktop-tests']);
    expect(packageWorkflow).not.toMatch(/desktop|tauri/iu);
    expect(desktopWorkflow).not.toContain('package-checks');
    expect(desktopWorkflow).not.toContain('package-tests');
    expect(workflowFiles).not.toContain('tests.yml');
  });

  it('runs Packages CI for every pull request and main push', () => {
    expect(triggerSection(packageWorkflow)).toBe(
      ['on:', '  push:', '    branches:', '      - main', '  pull_request:'].join('\n'),
    );
    expect(pullRequestPaths(packageWorkflow)).toEqual([]);
  });

  it('uses the native desktop path contract and an unfiltered main push', () => {
    const trigger = triggerSection(desktopWorkflow);
    const pullRequestStart = trigger.indexOf('  pull_request:');

    expect(trigger.slice(0, pullRequestStart)).toBe(
      ['on:', '  push:', '    branches:', '      - main'].join('\n') + '\n',
    );
    expect(pullRequestPaths(desktopWorkflow)).toEqual(desktopPullRequestPaths);
    expect(trigger.slice(0, pullRequestStart)).not.toContain('paths');
  });

  it('rejects unsupported trigger modes and selection mechanisms', () => {
    for (const source of [packageWorkflow, desktopWorkflow]) {
      expect(source).not.toMatch(
        /^ {2}(?:schedule|workflow_dispatch|merge_group|pull_request_target):/mu,
      );
      expect(source).not.toMatch(forbiddenSelectionLogic);
      expect(source).not.toMatch(/^ {2}paths-ignore:/mu);
    }

    expect(existsSync(new URL('../scripts/session-deck-ci-classifier.mjs', WORKFLOWS_ROOT))).toBe(
      false,
    );
    expect(
      existsSync(
        new URL('../scripts/__tests__/session-deck-ci-classifier.test.mjs', WORKFLOWS_ROOT),
      ),
    ).toBe(false);
    expect(
      workflowFiles.map((file) => readFileSync(new URL(file, WORKFLOWS_ROOT), 'utf8')).join('\n'),
    ).not.toContain('CI Gate');
  });

  it('keeps both workflows unconditional and parallel', () => {
    for (const [source, names] of [
      [packageWorkflow, ['package-checks', 'package-tests']],
      [desktopWorkflow, ['desktop-checks', 'desktop-tests']],
    ] as const) {
      for (const name of names) {
        expect(job(source, name)).not.toMatch(/^ {4}(?:needs|if):/mu);
      }
    }

    expectSafeConcurrency(packageWorkflow, 'packages-ci');
    expectSafeConcurrency(desktopWorkflow, 'session-deck-desktop-ci');
    expect(concurrencyGroup(packageWorkflow)).not.toBe(concurrencyGroup(desktopWorkflow));
    expect(concurrencyGroup(packageWorkflow).split('${{')[0]).not.toBe(
      concurrencyGroup(desktopWorkflow).split('${{')[0],
    );
  });

  it('preserves package checks and tests without desktop setup', () => {
    for (const packageJob of [packageChecksJob, packageTestsJob]) {
      expect(packageJob).not.toContain('apt-get');
      expect(packageJob).not.toContain('Install Tauri Linux system dependencies');
      expectCommandsInOrder(packageJob, [
        'uses: actions/checkout@v4',
        'uses: pnpm/action-setup@v4',
        'uses: actions/setup-node@v4',
        'run: pnpm install --frozen-lockfile',
        "run: pnpm -r --filter './packages/*' --if-present build",
      ]);
    }

    expectCommandsInOrder(packageChecksJob, [
      'run: pnpm lint',
      'run: pnpm format:check',
      'run: pnpm typecheck',
    ]);
    expectCommandsInOrder(packageTestsJob, ['run: pnpm test']);
    expect(packageTestsJob).not.toMatch(/classifier|classification_error|run_desktop/iu);
  });

  it('preserves desktop checks and tests setup and commands', () => {
    for (const desktopJob of [desktopChecksJob, desktopTestsJob]) {
      expect(desktopJob).toContain('uses: actions/checkout@v4');
      expect(desktopJob).toContain('uses: pnpm/action-setup@v4');
      expect(desktopJob).toContain('uses: actions/setup-node@v4');
      expect(desktopJob).toContain('node-version: 20');
      expect(desktopJob).toContain("cache: 'pnpm'");
      expect(desktopJob).toContain('sudo apt-get update');
      expect(desktopJob).toContain('sudo apt-get install -y --no-install-recommends');
      expect(desktopJob).toContain('libwebkit2gtk-4.1-dev');
      expect(desktopJob).toContain('run: pnpm install --frozen-lockfile');
    }

    expectCommandsInOrder(desktopChecksJob, [
      "run: pnpm -r --filter './packages/*' --if-present build",
      'pnpm --filter ./apps/session-deck-desktop sync:web',
      'git diff --exit-code --',
      'run: pnpm --filter ./apps/session-deck-desktop build',
      'run: pnpm --filter ./apps/session-deck-desktop lint',
      'run: pnpm --filter ./apps/session-deck-desktop format:check',
      'run: pnpm --filter ./apps/session-deck-desktop typecheck',
    ]);
    expectCommandsInOrder(desktopTestsJob, ['run: pnpm --filter ./apps/session-deck-desktop test']);
    expect(desktopWorkflow.match(/sudo apt-get install -y --no-install-recommends/gu)).toHaveLength(
      2,
    );
  });

  it('covers positive and non-trigger path fixtures against the native filter', () => {
    for (const repositoryPath of positivePaths) {
      expect(startsDesktopForPath(repositoryPath), repositoryPath).toBe(true);
    }
    for (const repositoryPath of nonTriggerPaths) {
      expect(startsDesktopForPath(repositoryPath), repositoryPath).toBe(false);
    }

    expect(pullRequestPaths(desktopWorkflow)).toEqual(
      expect.arrayContaining(['packages/pi-session-deck/tsconfig*.json', '.github/workflows/**']),
    );
  });
});

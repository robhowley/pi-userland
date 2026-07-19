import type { Dirent } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { visibleWidth, type KeyId } from '@mariozechner/pi-tui';
import type { Theme } from '@earendil-works/pi-coding-agent';

vi.mock('@mariozechner/pi-tui', async () => {
  const actual =
    await vi.importActual<typeof import('@mariozechner/pi-tui')>('@mariozechner/pi-tui');
  const visibleWidth = (value: string) => value.length;
  const truncateToWidth = (value: string, width: number) => value.slice(0, Math.max(0, width));
  const wrapTextWithAnsi = (value: string, width: number) => {
    if (visibleWidth(value) <= width) {
      return [value];
    }
    const lines: string[] = [];
    for (let index = 0; index < value.length; index += width) {
      lines.push(value.slice(index, index + width));
    }
    return lines;
  };

  return {
    ...actual,
    matchesKey: (data: string, key: KeyId) => data === key || actual.matchesKey(data, key),
    truncateToWidth,
    visibleWidth,
    wrapTextWithAnsi,
  };
});

import { SessionDeckBrowser } from '../../extensions/session-deck/browser.js';
import { withTerminalDisplayHints } from '../../extensions/session-deck/browser-view.js';
import type {
  SessionDeckRecord,
  SessionDeckSnapshot,
} from '../../extensions/session-deck/types.js';
import type {
  CreateWorktreeActionResult,
  CreateWorktreeFailureReason,
} from '../../extensions/session-deck/worktree/types.js';

const HOME = process.env['HOME'] ?? '/home/user';
const openBrowsers: SessionDeckBrowser[] = [];

afterEach(() => {
  for (const browser of openBrowsers) {
    browser.dispose();
  }
  openBrowsers.length = 0;
  vi.useRealTimers();
});

function createTheme(overrides: Partial<Theme> = {}): Theme {
  return {
    bold: (text: string) => text,
    fg: (_tone: string, text: string) => text,
    ...overrides,
  } as Theme;
}

function buildSnapshotRecord(overrides: Partial<SessionDeckRecord> = {}): SessionDeckRecord {
  return {
    runtimeId: '922f7ac8deadbeef',
    pid: 101,
    presenceState: 'live',
    presenceReason: 'fresh_heartbeat',
    heartbeatAgeMs: 5_000,
    sessionId: 'session-abc',
    sessionName: 'alpha',
    repoName: 'project',
    qualifiedRepoName: 'owner/project',
    cwd: `${HOME}/project`,
    branch: 'main',
    prUrl: 'https://github.com/owner/repo/pull/42',
    isLinkedWorktree: false,
    worktreeLabel: null,
    activityState: 'idle',
    activityAgeMs: null,
    currentToolName: null,
    lastError: null,
    chips: ['merge-ready clean'],
    diagnostics: [],
    ...overrides,
  };
}

function buildSnapshot(
  options: {
    records?: SessionDeckRecord[];
  } = {},
): SessionDeckSnapshot {
  return {
    generatedAt: '2026-06-23T12:10:00.000Z',
    records: options.records ?? [buildSnapshotRecord()],
    diagnostics: [],
  };
}

function renderLines(browser: SessionDeckBrowser, width = 120): string[] {
  return browser.render(width);
}

function renderText(browser: SessionDeckBrowser, width = 120): string {
  return renderLines(browser, width).join('\n');
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function buildRepoRecord(
  runtimeId: string,
  sessionName: string,
  repoName: string | null,
  qualifiedRepoName: string | null,
  overrides: Partial<SessionDeckRecord> = {},
): SessionDeckRecord {
  return buildSnapshotRecord({
    runtimeId,
    pid: overrides.pid ?? 100,
    sessionId: overrides.sessionId ?? `session-${runtimeId}`,
    sessionName,
    repoName,
    qualifiedRepoName,
    cwd: repoName === null ? `${HOME}/scratch/${runtimeId}` : `${HOME}/${repoName}`,
    branch: repoName === null ? null : 'main',
    prUrl: repoName === null ? null : 'https://github.com/example/repo/pull/1',
    chips: [],
    ...overrides,
  });
}

type SessionDerivedFacets = NonNullable<SessionDeckRecord['derivedFacets']>;

function buildDerivedFacets(
  rowKind: SessionDerivedFacets['rowKind'],
  overrides: Partial<Omit<SessionDerivedFacets, 'rowKind'>> = {},
): SessionDerivedFacets {
  return {
    persistence: rowKind === 'durable_session' ? 'file_backed' : 'in_memory',
    rowKind,
    interactivity: 'interactive',
    lifecycle: 'startup',
    lineage: 'root',
    identityStrength: 'strong',
    headerConsistency: 'consistent',
    ...overrides,
  };
}

function findLineIndex(
  lines: string[],
  predicate: (line: string) => boolean,
  description: string,
): number {
  const index = lines.findIndex(predicate);
  expect(index, `expected ${description}`).toBeGreaterThanOrEqual(0);
  return index;
}

function getRepoRow(lines: string[], labels: string[]): string {
  const row = lines.find(
    (line) => labels.filter((label) => line.includes(label)).length >= Math.min(2, labels.length),
  );
  expect(row, `expected repo row with labels: ${labels.join(', ')}`).toBeDefined();
  return row!;
}

function expectLabelsInOrder(line: string, labels: string[]): void {
  let previousIndex = -1;

  for (const label of labels) {
    const index = line.indexOf(label);
    expect(index, `expected ${label} in ${line}`).toBeGreaterThanOrEqual(0);
    expect(index).toBeGreaterThan(previousIndex);
    previousIndex = index;
  }
}

function countVisibleLabels(line: string, labels: string[]): number {
  return labels.filter((label) => line.includes(label)).length;
}

function createBrowser(
  overrides: Partial<{
    all: boolean;
    showIdentity: boolean;
    initialView: SessionDeckSnapshot;
    onClose: () => void;
    reload: () => Promise<SessionDeckSnapshot>;
    requestRender: () => void;
    reapLines: string[];
    theme: Theme;
    openSelected: (record: SessionDeckRecord) => Promise<{ ok: boolean; message: string }>;
    killSelected: (record: SessionDeckRecord) => Promise<{ ok: boolean; message: string }>;
    createWorktree: ConstructorParameters<typeof SessionDeckBrowser>[0]['createWorktree'];
    previewLaunchContext: ConstructorParameters<
      typeof SessionDeckBrowser
    >[0]['previewLaunchContext'];
  }> = {},
): SessionDeckBrowser {
  const browser = new SessionDeckBrowser({
    all: overrides.all ?? false,
    showIdentity: overrides.showIdentity ?? false,
    initialView: overrides.initialView ?? buildSnapshot(),
    onClose: overrides.onClose ?? (() => {}),
    reload: overrides.reload ?? (async () => overrides.initialView ?? buildSnapshot()),
    requestRender: overrides.requestRender ?? (() => {}),
    ...(overrides.reapLines === undefined ? {} : { reapLines: overrides.reapLines }),
    ...(overrides.openSelected === undefined ? {} : { openSelected: overrides.openSelected }),
    ...(overrides.killSelected === undefined ? {} : { killSelected: overrides.killSelected }),
    ...(overrides.createWorktree === undefined ? {} : { createWorktree: overrides.createWorktree }),
    ...(overrides.previewLaunchContext === undefined
      ? {}
      : { previewLaunchContext: overrides.previewLaunchContext }),
    theme: overrides.theme ?? createTheme(),
  });

  openBrowsers.push(browser);
  return browser;
}

function buildCreateWorktreeFailureResult(
  reason: CreateWorktreeFailureReason,
  message: string,
): Extract<CreateWorktreeActionResult, { ok: false; status: 'failed' }> {
  return {
    ok: false,
    status: 'failed',
    failurePhase: 'planning',
    worktree: {
      ok: false,
      reason,
      message,
      recoverable: true,
    },
    launch: {
      requested: false,
      mode: 'tmux-detached',
      status: 'not-started',
    },
  };
}

describe('SessionDeckBrowser', () => {
  it('renders the empty-state fallback', () => {
    const browser = createBrowser({
      initialView: buildSnapshot({ records: [] }),
    });

    expect(renderText(browser)).toContain('No live or stale Pi sessions found.');
  });

  it('renders the empty-state fallback when only temp sessions are present', () => {
    const browser = createBrowser({
      initialView: buildSnapshot({
        records: [
          buildSnapshotRecord({
            runtimeId: 'rt-temp-only',
            sessionName: 'temp-only',
            derivedFacets: buildDerivedFacets('ephemeral_child_runtime'),
          }),
        ],
      }),
    });

    const output = renderText(browser);

    expect(output).toContain('Pi sessions · 0 live');
    expect(output).toContain('No live or stale Pi sessions found.');
    expect(output).toContain('No selected session.');
    expect(output).not.toContain('temp-only');
  });

  it('counts only visible non-temp rows in the all-mode summary', () => {
    const browser = createBrowser({
      all: true,
      initialView: buildSnapshot({
        records: [
          buildSnapshotRecord({ runtimeId: 'rt-live-1', sessionName: 'visible-one' }),
          buildSnapshotRecord({
            runtimeId: 'rt-live-2',
            pid: 202,
            sessionId: 'session-live-2',
            sessionName: 'visible-two',
          }),
          buildSnapshotRecord({
            runtimeId: 'rt-temp-live',
            pid: 303,
            sessionId: 'session-temp-live',
            sessionName: 'temp-live',
            derivedFacets: buildDerivedFacets('ephemeral_child_runtime'),
          }),
          buildSnapshotRecord({
            runtimeId: 'rt-stale',
            pid: 404,
            sessionId: 'session-stale',
            sessionName: 'stale-visible',
            presenceState: 'stale',
            presenceReason: 'heartbeat_expired',
          }),
          buildSnapshotRecord({
            runtimeId: 'rt-temp-stale',
            pid: 505,
            sessionId: 'session-temp-stale',
            sessionName: 'temp-stale',
            presenceState: 'stale',
            presenceReason: 'heartbeat_expired',
            derivedFacets: buildDerivedFacets('ephemeral_child_runtime'),
          }),
          buildSnapshotRecord({
            runtimeId: 'rt-temp-dead',
            pid: 606,
            sessionId: 'session-temp-dead',
            sessionName: 'temp-dead',
            presenceState: 'dead',
            presenceReason: 'pid_missing',
            derivedFacets: buildDerivedFacets('ephemeral_child_runtime'),
          }),
          buildSnapshotRecord({
            runtimeId: 'rt-unknown',
            pid: 707,
            sessionId: 'session-unknown',
            sessionName: 'unknown-visible',
            presenceState: 'unknown',
            presenceReason: 'heartbeat_unreadable',
          }),
        ],
      }),
    });

    expect(renderText(browser)).toContain(
      'Pi sessions · 2 live · 1 stale · 0 dead · 1 unknown',
    );
  });

  it('renders reap summary lines above the browser list when provided', () => {
    const browser = createBrowser({
      reapLines: ['Reap complete: removed 1 expired presence record.', 'Removed:', '- rt-expired'],
    });

    const output = renderText(browser);

    expect(output).toContain('Reap complete: removed 1 expired presence record.');
    expect(output).toContain('Removed:');
    expect(output).toContain('- rt-expired');
    expect(output).toContain('› ○ idle  alpha  project · #42 · 5s · main');
  });

  it('shows repo-switch help text and places the repo row between reap chrome and the list', () => {
    const browser = createBrowser({
      initialView: buildSnapshot({
        records: [
          buildRepoRecord('rt-alpha', 'alpha-session', 'alpha', 'org/alpha'),
          buildRepoRecord('rt-none', 'scratch-worker', null, null),
        ],
      }),
      reapLines: ['Reap complete: removed 1 expired presence record.'],
    });

    const lines = renderLines(browser);
    const helpIndex = findLineIndex(
      lines,
      (line) =>
        line.includes(
          '↑↓ move · ←→ switch repo · enter details · w new Pi session · o open terminal · k end session · r refresh · q close',
        ),
      'help line',
    );
    const reapIndex = findLineIndex(lines, (line) => line.includes('Reap complete:'), 'reap line');
    const repoRowIndex = findLineIndex(
      lines,
      (line) => line.includes('all') && line.includes('alpha') && line.includes('N/A'),
      'repo row',
    );
    const listIndex = findLineIndex(lines, (line) => line.startsWith('› '), 'selected list row');

    expect(helpIndex).toBeLessThan(reapIndex);
    expect(reapIndex).toBeLessThan(repoRowIndex);
    expect(lines[repoRowIndex + 1]).toBe('');
    expect(listIndex).toBe(repoRowIndex + 2);
  });

  it('sorts named repo filters alphabetically by short name', () => {
    const browser = createBrowser({
      initialView: buildSnapshot({
        records: [
          buildRepoRecord('rt-zeta', 'zeta-session', 'zeta', 'org/zeta'),
          buildRepoRecord('rt-beta', 'beta-session', 'beta', 'org/beta'),
          buildRepoRecord('rt-alpha', 'alpha-session', 'alpha', 'org/alpha'),
        ],
      }),
    });

    const repoRow = getRepoRow(renderLines(browser), ['all', 'alpha', 'beta', 'zeta']);

    expectLabelsInOrder(repoRow, ['all', 'alpha', 'beta', 'zeta']);
  });

  it('uses qualified repo labels only for collided short-name filters', () => {
    const browser = createBrowser({
      initialView: buildSnapshot({
        records: [
          buildRepoRecord('rt-b', 'alpha-b', 'alpha', 'owner-b/alpha'),
          buildRepoRecord('rt-g', 'gamma-session', 'gamma', 'org/gamma'),
          buildRepoRecord('rt-a', 'alpha-a', 'alpha', 'owner-a/alpha'),
        ],
      }),
    });

    const repoRow = getRepoRow(renderLines(browser), [
      'all',
      'owner-a/alpha',
      'owner-b/alpha',
      'gamma',
    ]);

    expectLabelsInOrder(repoRow, ['all', 'owner-a/alpha', 'owner-b/alpha', 'gamma']);
    expect(repoRow).not.toContain('org/gamma');
  });

  it('merges legacy and qualified records for the same short repo when only one qualified identity exists', () => {
    const browser = createBrowser({
      initialView: buildSnapshot({
        records: [
          buildRepoRecord('rt-alpha-legacy', 'alpha-legacy', 'alpha', null),
          buildRepoRecord('rt-beta', 'beta-session', 'beta', 'org/beta'),
          buildRepoRecord('rt-alpha-qualified', 'alpha-qualified', 'alpha', 'owner/alpha', {
            pid: 202,
            sessionId: 'session-alpha-qualified',
          }),
        ],
      }),
    });

    const repoRow = getRepoRow(renderLines(browser), ['all', 'alpha', 'beta']);

    expectLabelsInOrder(repoRow, ['all', 'alpha', 'beta']);
    expect(repoRow).not.toContain('owner/alpha');

    browser.handleInput('right');

    const output = renderText(browser);
    expect(output).toContain('› ○ idle  alpha-legacy  alpha · #1 · 5s · main');
    expect(output).toContain('  ○ idle  alpha-qualified  alpha · #1 · 5s · main');
    expect(output).toContain('│ alpha-legacy');
    expect(output).not.toContain('beta-session');
  });

  it('uses a sliding four-label repo window with chevrons when there are more than four options', () => {
    const browser = createBrowser({
      initialView: buildSnapshot({
        records: [
          buildRepoRecord('rt-alpha', 'session-a', 'alpha', 'org/alpha'),
          buildRepoRecord('rt-beta', 'session-b', 'beta', 'org/beta'),
          buildRepoRecord('rt-charlie', 'session-c', 'charlie', 'org/charlie'),
          buildRepoRecord('rt-delta', 'session-d', 'delta', 'org/delta'),
          buildRepoRecord('rt-echo', 'session-e', 'echo', 'org/echo'),
          buildRepoRecord('rt-foxtrot', 'session-f', 'foxtrot', 'org/foxtrot'),
          buildRepoRecord('rt-none', 'session-n', null, null),
        ],
      }),
    });

    const labels = ['all', 'alpha', 'beta', 'charlie', 'delta', 'echo', 'foxtrot', 'N/A'];
    const initialRow = getRepoRow(renderLines(browser), ['all', 'alpha', 'beta', 'charlie']);

    expect(initialRow).toContain('‹');
    expect(initialRow).toContain('›');
    expect(countVisibleLabels(initialRow, labels)).toBe(4);
    expect(initialRow).not.toContain('delta');

    for (let index = 0; index < 7; index += 1) {
      browser.handleInput('right');
    }

    const endRow = getRepoRow(renderLines(browser), ['delta', 'echo', 'foxtrot', 'N/A']);

    expect(endRow).toContain('‹');
    expect(endRow).toContain('›');
    expect(countVisibleLabels(endRow, labels)).toBe(4);
    expect(endRow).toContain('delta');
    expect(endRow).toContain('echo');
    expect(endRow).toContain('foxtrot');
    expect(endRow).toContain('N/A');
    expect(endRow).not.toContain('all');
    expect(endRow).not.toContain('alpha');
    expect(endRow).not.toContain('beta');
    expect(endRow).not.toContain('charlie');
  });

  it('accents the selected repo label instead of rendering bracket literals', () => {
    const fg = vi.fn((_tone: string, text: string) => text);
    const browser = createBrowser({
      theme: createTheme({ fg }),
      initialView: buildSnapshot({
        records: [
          buildRepoRecord('rt-alpha', 'alpha-session', 'alpha', 'org/alpha'),
          buildRepoRecord('rt-none', 'scratch-worker', null, null),
        ],
      }),
    });

    browser.handleInput('right');
    browser.handleInput('right');

    const output = renderText(browser);
    const accentText = vi
      .mocked(fg)
      .mock.calls.filter(([tone]) => tone === 'accent')
      .map(([, text]) => text);

    expect(output).toContain('N/A');
    expect(output).not.toContain('[N/A]');
    expect(accentText.some((text) => text.includes('N/A'))).toBe(true);
  });

  it('switches repo filters and updates the visible rows and selected card', () => {
    const browser = createBrowser({
      initialView: buildSnapshot({
        records: [
          buildRepoRecord('rt-alpha', 'alpha-session', 'alpha', 'org/alpha'),
          buildRepoRecord('rt-beta', 'beta-session', 'beta', 'org/beta'),
        ],
      }),
    });

    browser.handleInput('right');
    browser.handleInput('right');

    const output = renderText(browser);

    expect(output).toContain('› ○ idle  beta-session  beta · #1 · 5s · main');
    expect(output).toContain('│ beta-session');
    expect(output).not.toContain('alpha-session  alpha');
  });

  it('preserves the selected runtime when switching repo filters if it remains visible', () => {
    const browser = createBrowser({
      initialView: buildSnapshot({
        records: [
          buildRepoRecord('rt-alpha-1', 'alpha-one', 'alpha', 'org/alpha'),
          buildRepoRecord('rt-beta', 'beta-one', 'beta', 'org/beta'),
          buildRepoRecord('rt-alpha-2', 'alpha-two', 'alpha', 'org/alpha'),
        ],
      }),
    });

    browser.handleInput('down');
    browser.handleInput('down');
    browser.handleInput('right');

    const output = renderText(browser);

    expect(output).toContain('  ○ idle  alpha-one  alpha · #1 · 5s · main');
    expect(output).toContain('› ○ idle  alpha-two  alpha · #1 · 5s · main');
    expect(output).toContain('│ alpha-two');
    expect(output).not.toContain('beta-one');
  });

  it('resets to the first visible row when switching repo filters hides the selected runtime', () => {
    const browser = createBrowser({
      initialView: buildSnapshot({
        records: [
          buildRepoRecord('rt-alpha-1', 'alpha-one', 'alpha', 'org/alpha'),
          buildRepoRecord('rt-beta', 'beta-one', 'beta', 'org/beta'),
          buildRepoRecord('rt-alpha-2', 'alpha-two', 'alpha', 'org/alpha'),
        ],
      }),
    });

    browser.handleInput('down');
    browser.handleInput('right');

    const output = renderText(browser);

    expect(output).toContain('› ○ idle  alpha-one  alpha · #1 · 5s · main');
    expect(output).toContain('  ○ idle  alpha-two  alpha · #1 · 5s · main');
    expect(output).toContain('│ alpha-one');
    expect(output).not.toContain('beta-one');
  });

  it('adds N/A last only when no-repo sessions exist and filters those rows', () => {
    const browser = createBrowser({
      initialView: buildSnapshot({
        records: [
          buildRepoRecord('rt-alpha', 'alpha-session', 'alpha', 'org/alpha'),
          buildRepoRecord('rt-beta', 'beta-session', 'beta', 'org/beta'),
          buildRepoRecord('rt-none', 'scratch-worker', null, null, { cwd: null }),
        ],
      }),
    });

    const repoRow = getRepoRow(renderLines(browser), ['all', 'alpha', 'beta', 'N/A']);
    expectLabelsInOrder(repoRow, ['all', 'alpha', 'beta', 'N/A']);

    browser.handleInput('right');
    browser.handleInput('right');
    browser.handleInput('right');

    const output = renderText(browser);

    expect(output).toContain('› ○ idle  scratch-worker  5s');
    expect(output).toContain('│ scratch-worker');
    expect(output).not.toContain('alpha-session');
    expect(output).not.toContain('beta-session');
    expect(output).not.toContain('│ repo:');
  });

  it('omits the N/A repo filter when every visible session has repo identity', () => {
    const browser = createBrowser({
      initialView: buildSnapshot({
        records: [
          buildRepoRecord('rt-alpha', 'alpha-session', 'alpha', 'org/alpha'),
          buildRepoRecord('rt-beta', 'beta-session', 'beta', 'org/beta'),
        ],
      }),
    });

    const repoRow = getRepoRow(renderLines(browser), ['all', 'alpha', 'beta']);

    expect(repoRow).not.toContain('N/A');
  });

  it('omits temp sessions from the main list and repo buckets', () => {
    const browser = createBrowser({
      initialView: buildSnapshot({
        records: [
          buildRepoRecord('rt-alpha', 'alpha-session', 'alpha', 'org/alpha'),
          buildRepoRecord('rt-temp-beta', 'temp-beta', 'beta', 'org/beta', {
            derivedFacets: buildDerivedFacets('ephemeral_child_runtime'),
          }),
          buildRepoRecord('rt-temp-scratch', 'temp-scratch', null, null, {
            cwd: null,
            branch: null,
            prUrl: null,
            derivedFacets: buildDerivedFacets('ephemeral_child_runtime'),
          }),
          buildRepoRecord('rt-gamma', 'gamma-session', 'gamma', 'org/gamma'),
        ],
      }),
    });

    let output = renderText(browser);
    const repoRow = getRepoRow(renderLines(browser), ['all', 'alpha', 'gamma']);

    expect(output).toContain('Pi sessions · 2 live');
    expect(repoRow).not.toContain('beta');
    expect(repoRow).not.toContain('N/A');
    expect(output).toContain('alpha-session');
    expect(output).toContain('gamma-session');
    expect(output).not.toContain('temp-beta');
    expect(output).not.toContain('temp-scratch');

    browser.handleInput('right');
    output = renderText(browser);
    expect(output).toContain('› ○ idle  alpha-session  alpha · #1 · 5s · main');
    expect(output).not.toContain('gamma-session');
    expect(output).not.toContain('temp-beta');

    browser.handleInput('right');
    output = renderText(browser);
    expect(output).toContain('› ○ idle  gamma-session  gamma · #1 · 5s · main');
    expect(output).not.toContain('alpha-session');
    expect(output).not.toContain('temp-scratch');
  });

  it('keeps real __all__ and __no-repo__ repo names distinct from special filters', () => {
    const browser = createBrowser({
      initialView: buildSnapshot({
        records: [
          buildRepoRecord('rt-all-name', 'all-name-session', '__all__', null),
          buildRepoRecord('rt-no-name', 'no-name-session', '__no-repo__', null, {
            pid: 202,
            sessionId: 'session-no-name',
          }),
          buildRepoRecord('rt-none', 'scratch-worker', null, null, {
            pid: 303,
            sessionId: 'session-none',
            cwd: null,
            branch: null,
            prUrl: null,
          }),
        ],
      }),
    });

    const repoRow = renderLines(browser).find(
      (line) => line.includes('__all__') && line.includes('__no-repo__') && line.includes('N/A'),
    );
    expect(repoRow).toBeDefined();

    browser.handleInput('right');

    let output = renderText(browser);
    expect(output).toContain('› ○ idle  all-name-session  __all__ · #1 · 5s · main');
    expect(output).not.toContain('no-name-session');
    expect(output).not.toContain('scratch-worker');

    browser.handleInput('right');

    output = renderText(browser);
    expect(output).toContain('› ○ idle  no-name-session  __no-repo__ · #1 · 5s · main');
    expect(output).not.toContain('all-name-session');
    expect(output).not.toContain('scratch-worker');

    browser.handleInput('right');

    output = renderText(browser);
    expect(output).toContain('› ○ idle  scratch-worker  5s');
    expect(output).toContain('│ scratch-worker');
    expect(output).not.toContain('all-name-session');
    expect(output).not.toContain('no-name-session');
  });

  it('keeps the top-pane list shape and shows session ids by default only in the selected card', () => {
    const browser = createBrowser({
      all: true,
      initialView: buildSnapshot({
        records: [
          buildSnapshotRecord({
            chips: ['merge-ready clean', 'queue 2'],
            isLinkedWorktree: true,
            worktreeLabel: 'feature-sandbox',
            diagnostics: [{ code: 'activity_stale', message: 'Activity record is stale' }],
          }),
          buildSnapshotRecord({
            runtimeId: 'rt-2',
            pid: 202,
            sessionId: 'session-2',
            sessionName: 'bravo',
            presenceState: 'stale',
            presenceReason: 'heartbeat_expired',
            heartbeatAgeMs: 240_000,
            activityState: 'thinking',
            activityAgeMs: 180_000,
            chips: [],
          }),
        ],
      }),
    });

    const output = renderText(browser);

    expect(output).toContain('Pi sessions · 1 live · 1 stale · 0 dead · 0 unknown');
    expect(output).toContain('› ○ idle  alpha  project · #42 · 5s · main');
    expect(output).toContain('  │ merge-ready clean · queue 2');
    expect(output).toContain('  ◒ thinking  bravo  project · #42 · 4m · main');
    expect(output).toContain('    no chips');
    expect(output).toContain(
      '  │ merge-ready clean · queue 2\n\n  ◒ thinking  bravo  project · #42 · 4m · main',
    );
    expect(output).not.toContain('Selected session');
    expect(output).toContain('┌');
    expect(output).toContain('│ alpha');
    expect(output).toContain('│ repo: owner/project');
    expect(output).toContain('│ cwd: ~/project');
    expect(output).toContain('│ checkout: worktree · feature-sandbox');
    expect(output).toContain('│ branch: main · pr: #42');
    expect(output).toContain('│ presence: ● live · activity: idle · heartbeat: 5s ago');
    expect(output).toContain('│ chips: merge-ready clean · queue 2');
    expect(output).toContain('│ session: session-abc · pid: 101');
    expect(output).toContain('│ runtime: 922f7ac8deadbeef');
    expect(output.indexOf('│ session: session-abc · pid: 101')).toBeLessThan(
      output.indexOf('│ runtime: 922f7ac8deadbeef'),
    );
    expect(output).not.toContain('│ runtime: 922f7ac8deadbeef · pid: 101');
    expect(output).toContain('│ diagnostics: activity_stale');
    expect(output).not.toContain('│   - merge-ready clean');
  });

  it('keeps the temp filter tied to rowKind instead of childRuntime confidence', () => {
    const browser = createBrowser({
      initialView: buildSnapshot({
        records: [
          buildSnapshotRecord({
            runtimeId: 'rt-high-child',
            sessionName: 'worker',
            chips: [],
            derivedFacets: buildDerivedFacets('ephemeral_child_runtime', {
              interactivity: 'headless',
              identityStrength: 'weak',
              childRuntime: {
                candidate: true,
                confidence: 'high',
                parentRuntimeId: 'rt-parent',
                evidence: [
                  {
                    code: 'inherited_deck_runtime',
                    confidence: 'high',
                    parentRuntimeId: 'rt-parent',
                  },
                  {
                    code: 'process_ancestor_match',
                    confidence: 'high',
                    parentRuntimeId: 'rt-parent',
                  },
                ],
              },
            }),
          }),
          buildSnapshotRecord({
            runtimeId: 'rt-env-only',
            sessionName: 'maybe',
            chips: [],
            derivedFacets: buildDerivedFacets('ephemeral_runtime', {
              childRuntime: {
                candidate: true,
                confidence: 'high',
                parentRuntimeId: 'rt-parent',
                evidence: [
                  {
                    code: 'inherited_deck_runtime',
                    confidence: 'high',
                    parentRuntimeId: 'rt-parent',
                  },
                ],
              },
            }),
          }),
        ],
      }),
    });

    const output = renderText(browser);

    expect(output).toContain('Pi sessions · 1 live');
    expect(output).toContain('› ○ idle  maybe  project · #42 · 5s · main');
    expect(output).toContain('│ maybe');
    expect(output).not.toContain('worker');
    expect(output).not.toContain('child: high via deck env');
    expect(output).not.toContain('child runtime: high via deck env');
  });

  it('shows active spawned child-runtime counts in the selected detail without leaking hidden child states into summary', () => {
    const browser = createBrowser({
      all: true,
      initialView: buildSnapshot({
        records: [
          buildSnapshotRecord({
            runtimeId: 'rt-parent',
            sessionId: 'session-parent',
            sessionName: 'parent',
            chips: [],
          }),
          buildSnapshotRecord({
            runtimeId: 'rt-child-live',
            sessionId: 'session-child-live',
            sessionName: 'child-live',
            chips: [],
            derivedFacets: buildDerivedFacets('ephemeral_child_runtime', {
              interactivity: 'headless',
              childRuntime: {
                candidate: true,
                confidence: 'high',
                parentRuntimeId: 'rt-parent',
                evidence: [
                  {
                    code: 'inherited_deck_runtime',
                    confidence: 'high',
                    parentRuntimeId: 'rt-parent',
                  },
                ],
              },
            }),
          }),
          buildSnapshotRecord({
            runtimeId: 'rt-child-dead',
            pid: 303,
            sessionId: 'session-child-dead',
            sessionName: 'child-dead',
            presenceState: 'dead',
            presenceReason: 'pid_missing',
            chips: [],
            derivedFacets: buildDerivedFacets('ephemeral_child_runtime', {
              interactivity: 'headless',
              childRuntime: {
                candidate: true,
                confidence: 'high',
                parentRuntimeId: 'rt-parent',
                evidence: [
                  {
                    code: 'process_ancestor_match',
                    confidence: 'high',
                    parentRuntimeId: 'rt-parent',
                  },
                ],
              },
            }),
          }),
          buildSnapshotRecord({
            runtimeId: 'rt-candidate',
            pid: 404,
            sessionId: 'session-candidate',
            sessionName: 'candidate',
            chips: [],
            derivedFacets: buildDerivedFacets('ephemeral_runtime', {
              childRuntime: {
                candidate: true,
                confidence: 'high',
                parentRuntimeId: 'rt-parent',
                evidence: [
                  {
                    code: 'inherited_deck_runtime',
                    confidence: 'high',
                    parentRuntimeId: 'rt-parent',
                  },
                ],
              },
            }),
          }),
        ],
      }),
    });

    const lines = renderLines(browser);
    const output = lines.join('\n');

    expect(lines[0]).toBe('Pi sessions · 2 live · 0 dead · 0 unknown');
    expect(output).toContain('candidate');
    expect(output).not.toContain('child-live');
    expect(output).not.toContain('child-dead');
    expect(output).toContain('│ Spawned: 1');
    expect(output).not.toContain('│ Spawned: 2');
    expect(output).not.toContain('Ephemeral child sessions excluded from the deck.');
  });

  it('uses the approved activity glyphs in top-pane rows without changing card presence text', () => {
    const browser = createBrowser({
      all: true,
      initialView: buildSnapshot({
        records: [
          buildSnapshotRecord({ sessionName: 'idle-row', chips: [] }),
          buildSnapshotRecord({
            runtimeId: 'rt-thinking',
            pid: 202,
            sessionId: 'session-thinking',
            sessionName: 'thinking-row',
            presenceState: 'stale',
            presenceReason: 'heartbeat_expired',
            heartbeatAgeMs: 240_000,
            activityState: 'thinking',
            activityAgeMs: 180_000,
            chips: [],
          }),
          buildSnapshotRecord({
            runtimeId: 'rt-tool',
            pid: 303,
            sessionId: 'session-tool',
            sessionName: 'tool-row',
            activityState: 'tool-running',
            activityAgeMs: 12_000,
            currentToolName: 'bash',
            chips: [],
          }),
          buildSnapshotRecord({
            runtimeId: 'rt-error',
            pid: 404,
            sessionId: 'session-error',
            sessionName: 'error-row',
            activityState: 'error',
            activityAgeMs: 42_000,
            lastError: 'boom',
            chips: [],
          }),
          buildSnapshotRecord({
            runtimeId: 'rt-unknown',
            pid: 505,
            sessionId: 'session-unknown',
            sessionName: 'unknown-row',
            presenceState: 'dead',
            presenceReason: 'pid_missing',
            heartbeatAgeMs: 540_000,
            activityState: 'unknown',
            chips: [],
          }),
        ],
      }),
    });

    const output = renderText(browser);

    expect(output).toContain('› ○ idle  idle-row  project · #42 · 5s · main');
    expect(output).toContain('  ◒ thinking  thinking-row  project · #42 · 4m · main');
    expect(output).toContain('  ◆ tool-running  tool-row  project · #42 · 12s · main');
    expect(output).toContain('  ! error  error-row  project · #42 · 42s · main');
    expect(output).toContain('  ? unknown  unknown-row  project · #42 · 9m · main');
    expect(output).toContain('│ presence: ● live · activity: idle · heartbeat: 5s ago');
  });

  it('shows the session id without inventing a pid when the selected runtime has none', () => {
    const browser = createBrowser({
      initialView: buildSnapshot({ records: [buildSnapshotRecord({ pid: null })] }),
    });

    const output = renderText(browser);

    expect(output).toContain('│ session: session-abc');
    expect(output).toContain('│ runtime: 922f7ac8deadbeef');
    expect(output.indexOf('│ session: session-abc')).toBeLessThan(
      output.indexOf('│ runtime: 922f7ac8deadbeef'),
    );
    expect(output).not.toContain('│ session: session-abc · pid:');
    expect(output).not.toContain('│ runtime: 922f7ac8deadbeef · pid:');
  });

  it('omits the checkout line for non-linked checkouts', () => {
    const browser = createBrowser({
      showIdentity: true,
      initialView: buildSnapshot({ records: [buildSnapshotRecord()] }),
    });

    expect(renderText(browser)).not.toContain('checkout: worktree');
  });

  it('falls back to a generic checkout line when the linked-worktree label is unavailable', () => {
    const browser = createBrowser({
      initialView: buildSnapshot({
        records: [buildSnapshotRecord({ isLinkedWorktree: true, worktreeLabel: null })],
      }),
    });

    const output = renderText(browser);

    expect(output).toContain('│ checkout: worktree');
    expect(output).not.toContain('│ checkout: worktree ·');
  });

  it('falls back to repoName in the inspector and omits the repo line when no repo is known', () => {
    const browser = createBrowser({
      initialView: buildSnapshot({
        records: [
          buildSnapshotRecord({ qualifiedRepoName: null }),
          buildSnapshotRecord({
            runtimeId: 'rt-2',
            sessionName: null,
            repoName: null,
            qualifiedRepoName: null,
            cwd: `${HOME}/scratch/worker`,
            branch: null,
            prUrl: null,
          }),
        ],
      }),
    });

    expect(renderText(browser)).toContain('│ repo: project');

    browser.handleInput('down');

    const output = renderText(browser);
    expect(output).toContain('│ worker');
    expect(output).not.toContain('│ repo:');
  });

  it('shows up to 8 sessions in the top list window before paging', () => {
    const browser = createBrowser({
      initialView: buildSnapshot({
        records: Array.from({ length: 13 }, (_, index) =>
          buildSnapshotRecord({
            runtimeId: `rt-${index + 1}`,
            pid: 100 + index,
            sessionId: `session-${index + 1}`,
            sessionName: `session-${index + 1}`,
            chips: [],
            branch: null,
            prUrl: null,
          }),
        ),
      }),
    });

    const output = renderText(browser);

    expect(output).toContain('Showing 1-8 of 13');
    expect(output).toContain('session-8');
    expect(output).not.toContain('session-9');
  });

  it('paginates the visible non-temp subset when temp sessions are present', () => {
    const visibleRecords = Array.from({ length: 10 }, (_, index) =>
      buildSnapshotRecord({
        runtimeId: `rt-visible-${index + 1}`,
        pid: 100 + index,
        sessionId: `session-visible-${index + 1}`,
        sessionName: `visible-${index + 1}`,
        chips: [],
        branch: null,
        prUrl: null,
      }),
    );
    const tempRecords = Array.from({ length: 3 }, (_, index) =>
      buildSnapshotRecord({
        runtimeId: `rt-temp-${index + 1}`,
        pid: 300 + index,
        sessionId: `session-temp-${index + 1}`,
        sessionName: `temp-${index + 1}`,
        chips: [],
        branch: null,
        prUrl: null,
        derivedFacets: buildDerivedFacets('ephemeral_child_runtime'),
      }),
    );
    const browser = createBrowser({
      initialView: buildSnapshot({ records: [...visibleRecords, ...tempRecords] }),
    });

    const output = renderText(browser);

    expect(output).toContain('Pi sessions · 10 live');
    expect(output).toContain('Showing 1-8 of 10');
    expect(output).toContain('visible-8');
    expect(output).not.toContain('visible-9');
    expect(output).not.toContain('temp-1');
  });

  it('keeps the 8-row session paging inside the active repo filter', () => {
    const alphaRecords = Array.from({ length: 10 }, (_, index) =>
      buildRepoRecord(`rt-alpha-${index + 1}`, `alpha-${index + 1}`, 'alpha', 'org/alpha', {
        pid: 200 + index,
        sessionId: `session-alpha-${index + 1}`,
      }),
    );
    const betaRecords = Array.from({ length: 3 }, (_, index) =>
      buildRepoRecord(`rt-beta-${index + 1}`, `beta-${index + 1}`, 'beta', 'org/beta', {
        pid: 400 + index,
        sessionId: `session-beta-${index + 1}`,
      }),
    );
    const browser = createBrowser({
      initialView: buildSnapshot({ records: [...alphaRecords, ...betaRecords] }),
    });

    browser.handleInput('right');
    const output = renderText(browser);

    expect(output).toContain('Showing 1-8 of 10');
    expect(output).toContain('alpha-8');
    expect(output).not.toContain('alpha-9');
    expect(output).not.toContain('beta-1');
  });

  it('uses session name, then repo name, then cwd basename, then runtime id in the list and card', () => {
    const browser = createBrowser({
      initialView: buildSnapshot({
        records: [
          buildSnapshotRecord({
            sessionName: null,
            repoName: 'repo-one',
            qualifiedRepoName: 'owner/repo-one',
            cwd: `${HOME}/repo-one/packages/cli`,
            branch: null,
            prUrl: null,
          }),
          buildSnapshotRecord({
            runtimeId: 'rt-2',
            sessionName: null,
            repoName: null,
            qualifiedRepoName: null,
            cwd: `${HOME}/scratch/worker`,
            branch: null,
            prUrl: null,
          }),
          buildSnapshotRecord({
            runtimeId: 'abcdef1234567890',
            pid: 303,
            sessionId: null,
            sessionName: null,
            repoName: null,
            qualifiedRepoName: null,
            cwd: null,
            branch: null,
            prUrl: null,
          }),
        ],
      }),
    });

    expect(renderText(browser)).toContain('› ○ idle  repo-one  5s');
    expect(renderText(browser)).toContain('│ repo-one');
    expect(renderText(browser)).toContain('│ repo: owner/repo-one');
    expect(renderText(browser)).toContain('│ cwd: ~/repo-one/packages/cli');

    browser.handleInput('down');

    let output = renderText(browser);
    expect(output).toContain('› ○ idle  worker  5s');
    expect(output).toContain('│ worker');
    expect(output).toContain('│ cwd: ~/scratch/worker');

    browser.handleInput('down');

    output = renderText(browser);
    expect(output).toContain('› ○ idle  abcdef12  5s');
    expect(output).toContain('│ abcdef12');
    expect(output).toContain('│ runtime: abcdef1234567890 · pid: 303');
    expect(output).not.toContain('│ session:');
  });

  it('moves selection and toggles the detail pane', () => {
    const requestRender = vi.fn();
    const browser = createBrowser({
      requestRender,
      initialView: buildSnapshot({
        records: [
          buildSnapshotRecord(),
          buildSnapshotRecord({
            runtimeId: 'rt-2',
            pid: 202,
            sessionId: 'session-2',
            sessionName: 'bravo',
            presenceState: 'stale',
            presenceReason: 'heartbeat_expired',
            heartbeatAgeMs: 240_000,
            activityState: 'thinking',
            activityAgeMs: 180_000,
            diagnostics: [{ code: 'activity_stale', message: 'Activity record is stale' }],
            chips: [],
          }),
        ],
      }),
    });

    browser.handleInput('down');

    expect(requestRender).toHaveBeenCalledTimes(1);
    const selectedOutput = renderText(browser);
    expect(selectedOutput).toContain('› ◒ thinking  bravo  project · #42 · 4m · main');
    expect(selectedOutput).toContain('│ repo: owner/project');
    expect(selectedOutput).toContain('  │ no chips');
    expect(selectedOutput).toContain(
      '│ presence: ◌ stale · activity: thinking · 3m · heartbeat: 4m ago · heartbeat expired',
    );
    expect(selectedOutput).toContain('│ session: session-2 · pid: 202');
    expect(selectedOutput).toContain('│ runtime: rt-2');
    expect(selectedOutput.indexOf('│ session: session-2 · pid: 202')).toBeLessThan(
      selectedOutput.indexOf('│ runtime: rt-2'),
    );
    expect(selectedOutput).not.toContain('│ runtime: rt-2 · pid: 202');
    expect(selectedOutput).not.toContain('│ chips:');
    expect(selectedOutput).not.toContain('│ diagnostics:');

    browser.handleInput('enter');

    expect(renderText(browser)).toContain('Details hidden');
  });

  it('dims stale and dead rows when they are not selected', () => {
    const fg = vi.fn((_tone: string, text: string) => text);
    const browser = createBrowser({
      all: true,
      theme: createTheme({ fg }),
      initialView: buildSnapshot({
        records: [
          buildSnapshotRecord(),
          buildSnapshotRecord({
            runtimeId: 'rt-2',
            sessionName: 'bravo',
            presenceState: 'stale',
            presenceReason: 'heartbeat_expired',
            heartbeatAgeMs: 240_000,
            activityState: 'thinking',
            activityAgeMs: 180_000,
          }),
          buildSnapshotRecord({
            runtimeId: 'rt-3',
            sessionName: 'charlie',
            presenceState: 'dead',
            presenceReason: 'pid_missing',
            heartbeatAgeMs: 540_000,
            activityState: 'unknown',
            chips: ['session warning'],
          }),
        ],
      }),
    });

    browser.render(120);

    const dimmedText = vi
      .mocked(fg)
      .mock.calls.filter(([tone]) => tone === 'dim')
      .map(([, text]) => text);

    expect(
      dimmedText.some((text) => text.includes('◒ thinking  bravo  project · #42 · 4m · main')),
    ).toBe(true);
    expect(
      dimmedText.some((text) => text.includes('? unknown  charlie  project · #42 · 9m · main')),
    ).toBe(true);
    expect(dimmedText.some((text) => text.includes('session warning'))).toBe(true);
  });

  it('keeps selected chip text readable by accenting only the line-2 gutter', () => {
    const fg = vi.fn((_tone: string, text: string) => text);
    const browser = createBrowser({
      theme: createTheme({ fg }),
      initialView: buildSnapshot({
        records: [buildSnapshotRecord({ chips: ['merge-ready clean', 'queue 2'] })],
      }),
    });

    browser.render(120);

    const accentText = vi
      .mocked(fg)
      .mock.calls.filter(([tone]) => tone === 'accent')
      .map(([, text]) => text);

    expect(accentText.some((text) => text.includes('› ○ idle  alpha'))).toBe(true);
    expect(accentText.some((text) => text === '  │ ')).toBe(true);
    expect(accentText.some((text) => text.includes('merge-ready clean · queue 2'))).toBe(false);
  });

  it('closes on q and escape', () => {
    const onClose = vi.fn();
    const browser = createBrowser({ onClose });
    const otherBrowser = createBrowser({ onClose });

    browser.handleInput('q');
    otherBrowser.handleInput('escape');

    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('renders browser-only tmux display hints without raw terminal data', () => {
    const browser = createBrowser({
      initialView: buildSnapshot({
        records: [
          {
            ...buildSnapshotRecord({ sessionName: 'pi session', chips: [] }),
            terminalDisplay: {
              kind: 'tmux',
              title: 'editor',
              detail: 'tmux prod:editor %12',
              openLabel: 'new iTerm2 tab attaches to tmux',
            },
          } as SessionDeckRecord,
        ],
      }),
    });

    const output = renderText(browser);

    expect(output).toContain('› ○ idle  editor  project · #42 · 5s · main');
    expect(output).toContain('  │ tmux prod:editor %12');
    expect(output).toContain('│ terminal: tmux prod:editor %12');
    expect(output).toContain('│ open: new iTerm2 tab attaches to tmux');
    expect(output).not.toContain('/tmp/tmux');
    expect(output).not.toContain('attachCommand');
    expect(output).not.toContain('sessionTarget');
  });

  it('hydrates terminalDisplay from a matching tmux identity sidecar without leaking raw terminal metadata', async () => {
    const runtimeId = 'rt-pr115-browser-hint';
    const socketPath = '/tmp/tmux-pr115/default';
    const attachCommand = `exec tmux -S ${socketPath} attach-session -t prod:editor`;
    const readdir = vi
      .fn()
      .mockResolvedValue([{ name: `${runtimeId}.json`, isFile: () => true } as unknown as Dirent]);
    const readFile = vi.fn().mockResolvedValue(
      JSON.stringify({
        runtimeId,
        terminal: {
          kind: 'tmux',
          socketPath,
          sessionName: 'prod',
          sessionId: '$1',
          windowName: 'editor',
          paneId: '%12',
          attachCommand,
          sessionTarget: 'prod:editor',
        },
      }),
    );

    const view = await withTerminalDisplayHints(
      buildSnapshot({
        records: [
          buildSnapshotRecord({
            runtimeId,
            sessionId: 'public-session',
            sessionName: 'pi session',
            chips: [],
          }),
        ],
      }),
      {
        identityDirectory: '/fake/pi-session-deck/identity',
        readdir,
        readFile,
      },
    );

    expect(readdir).toHaveBeenCalledWith('/fake/pi-session-deck/identity', { withFileTypes: true });
    expect(readFile).toHaveBeenCalledWith(
      `/fake/pi-session-deck/identity/${runtimeId}.json`,
      'utf8',
    );
    const publicRecord = view.records[0];
    expect(publicRecord?.terminalDisplay).toEqual({
      kind: 'tmux',
      title: 'editor',
      detail: 'tmux prod:editor %12',
      openLabel: 'new iTerm2 tab attaches to tmux',
    });
    expect(publicRecord?.sessionId).toBe('public-session');
    expect(publicRecord).not.toHaveProperty('terminal');
    expect(publicRecord).not.toHaveProperty('socketPath');
    expect(publicRecord).not.toHaveProperty('paneId');
    expect(publicRecord).not.toHaveProperty('attachCommand');
    expect(publicRecord).not.toHaveProperty('sessionTarget');

    const serialized = JSON.stringify(publicRecord ?? {});
    expect(serialized).not.toContain(socketPath);
    expect(serialized).not.toContain(attachCommand);
  });

  it('keeps browser hint snapshots free of accidental raw terminal fields', async () => {
    const leakyRecord = {
      ...buildSnapshotRecord({ sessionName: 'pi session', chips: [] }),
      terminal: {
        kind: 'tmux',
        socketPath: '/tmp/tmux/default',
        sessionName: 'prod',
        sessionTarget: '$1',
        paneId: '%12',
        attachCommand: 'exec tmux attach-session -t prod',
      },
      terminalDisplay: {
        kind: 'tmux',
        title: 'stale-display',
        detail: 'tmux stale %99',
        openLabel: 'stale',
      },
      socketPath: '/tmp/tmux/default',
      paneId: '%12',
      attachCommand: 'exec tmux attach-session -t prod',
      sessionTarget: '$1',
    } as SessionDeckRecord;

    const view = await withTerminalDisplayHints(buildSnapshot({ records: [leakyRecord] }), {
      readdir: vi.fn().mockResolvedValue([]),
    });

    expect(view.records[0]).not.toHaveProperty('terminal');
    expect(view.records[0]).not.toHaveProperty('terminalDisplay');
    expect(view.records[0]).not.toHaveProperty('socketPath');
    expect(view.records[0]).not.toHaveProperty('paneId');
    expect(view.records[0]).not.toHaveProperty('attachCommand');
    expect(view.records[0]).not.toHaveProperty('sessionTarget');
  });

  it('warns when w is used outside an active named repo filter', () => {
    const createWorktree = vi.fn();
    const browser = createBrowser({ createWorktree });

    browser.handleInput('w');

    expect(createWorktree).not.toHaveBeenCalled();
    expect(renderText(browser)).toContain(
      'Switch to a named repo filter before starting a new Pi session.',
    );
  });

  it('keeps the w prompt multi-line branch and Pi config form open when branch name is blank', () => {
    const createWorktree = vi.fn();
    const browser = createBrowser({ createWorktree });

    browser.handleInput('right');
    browser.handleInput('w');
    browser.handleInput('enter');

    expect(createWorktree).not.toHaveBeenCalled();
    const output = renderText(browser);
    expect(output).toContain('Enter a branch name.');
    expect(output).toContain('New Pi session for project');
    expect(output).toContain('Branch:    <branch-name>');
    expect(output).toContain('Pi config resolving…');
    expect(output).toContain('Base:      default branch · generated worktree · detached tmux');
    expect(output).toContain('tab focus');
    expect(output).not.toContain('worktree/<name>');
  });

  it('changes the TUI prompt Pi config to custom for one create request', async () => {
    const previewLaunchContext = vi.fn<
      NonNullable<ConstructorParameters<typeof SessionDeckBrowser>[0]['previewLaunchContext']>
    >(async (agentDir) => ({
      ok: true as const,
      status: 'resolved' as const,
      mode: agentDir.mode,
      envAction: agentDir.mode === 'custom' ? 'set' : 'inherit',
      effectiveDisplay: agentDir.mode === 'custom' ? '~/agent-work' : '~/.pi/agent-or',
      provenance: agentDir.mode === 'custom' ? 'request' : 'process-env',
      warnings: [],
    }));
    const createWorktree = vi.fn<
      NonNullable<ConstructorParameters<typeof SessionDeckBrowser>[0]['createWorktree']>
    >(async () => buildCreateWorktreeFailureResult('invalid-branch', 'stop after payload'));
    const browser = createBrowser({ createWorktree, previewLaunchContext });

    browser.handleInput('right');
    browser.handleInput('w');
    browser.handleInput('tab');
    browser.handleInput('enter');
    const selectorOutput = renderText(browser);
    expect(selectorOutput).toContain('Choose:    › Current');
    expect(selectorOutput).toContain('Pi default');
    expect(selectorOutput).not.toContain('Ambient env');
    expect(selectorOutput).not.toContain('Pi default (');
    browser.handleInput('down');
    browser.handleInput('down');
    for (const char of '~/agent-work') {
      browser.handleInput(char);
    }
    browser.handleInput('enter');
    await vi.waitFor(() => {
      expect(renderText(browser)).toContain('Pi config → ~/agent-work');
    });

    browser.handleInput('tab');
    for (const char of 'rh/feature') {
      browser.handleInput(char);
    }
    browser.handleInput('enter');

    await vi.waitFor(() => expect(createWorktree).toHaveBeenCalledTimes(1));
    expect(createWorktree.mock.calls[0]?.[0]).toMatchObject({
      branchName: 'rh/feature',
      launch: {
        mode: 'tmux-detached',
        agentDir: { mode: 'custom', customDir: expect.stringMatching(/\/agent-work$/u) },
      },
    });
  });

  it('cancels the new Pi session prompt on escape without closing the browser', () => {
    const onClose = vi.fn();
    const createWorktree = vi.fn();
    const browser = createBrowser({ onClose, createWorktree });

    browser.handleInput('right');
    browser.handleInput('w');
    browser.handleInput('escape');

    expect(onClose).not.toHaveBeenCalled();
    expect(createWorktree).not.toHaveBeenCalled();
    const output = renderText(browser);
    expect(output).toContain('New Pi session cancelled.');
    expect(output).not.toContain('Branch:    <branch-name>');
  });

  it('cancels the new Pi session prompt on ctrl+c without closing the browser', () => {
    const onClose = vi.fn();
    const createWorktree = vi.fn();
    const browser = createBrowser({ onClose, createWorktree });

    browser.handleInput('right');
    browser.handleInput('w');
    browser.handleInput('ctrl+c');

    expect(onClose).not.toHaveBeenCalled();
    expect(createWorktree).not.toHaveBeenCalled();
    const output = renderText(browser);
    expect(output).toContain('New Pi session cancelled.');
    expect(output).not.toContain('Branch:    <branch-name>');
  });

  it.each([
    [
      'branch validation fails',
      buildCreateWorktreeFailureResult('invalid-branch', 'Invalid Git branch name: rh/bad..branch'),
      'Invalid Git branch name: rh/bad..branch',
    ],
    [
      'base validation fails',
      buildCreateWorktreeFailureResult(
        'invalid-base-ref',
        'Base ref does not resolve to a commit.',
      ),
      'Base ref does not resolve to a commit.',
    ],
    [
      'repo resolution fails',
      buildCreateWorktreeFailureResult(
        'repo-intent-unresolved',
        'Could not resolve the selected repository.',
      ),
      'Could not resolve the selected repository.',
    ],
  ])('preserves the typed branch name when %s', async (_caseName, result, message) => {
    const createWorktree = vi.fn<
      NonNullable<ConstructorParameters<typeof SessionDeckBrowser>[0]['createWorktree']>
    >(async () => result);
    const browser = createBrowser({ createWorktree });

    browser.handleInput('right');
    browser.handleInput('w');
    for (const char of 'rh/bad..branch') {
      browser.handleInput(char);
    }
    browser.handleInput('enter');

    await vi.waitFor(() => expect(createWorktree).toHaveBeenCalledTimes(1));
    const output = renderText(browser);
    expect(output).toContain(message);
    expect(output).toContain('Branch:    rh/bad..branch');
  });

  it('submits w from a named repo filter with exact branchName, always requests detached tmux, and uses launched copy without runtime-id dependency', async () => {
    const openSelected = vi.fn();
    const createWorktree = vi.fn<
      NonNullable<ConstructorParameters<typeof SessionDeckBrowser>[0]['createWorktree']>
    >(async () => ({
      ok: true as const,
      status: 'created-and-launched' as const,
      worktree: {
        ok: true as const,
        status: 'created' as const,
        path: '/tmp/project-wt-feature',
        branch: 'rh/feature',
        baseRef: 'origin/main',
        repoName: 'project',
        qualifiedRepoName: 'owner/project',
        manualCommand: 'git worktree add ...',
      },
      launch: {
        requested: true as const,
        ok: true as const,
        mode: 'tmux-detached' as const,
        status: 'launched' as const,
        tmuxSessionName: 'pi-project-feature',
        tmuxTarget: '=pi-project-feature',
        message: 'Started a detached tmux Pi session.',
        manualAttachCommand: 'tmux attach-session -t =pi-project-feature',
      },
    }));
    const reload = vi.fn(async () => buildSnapshot());
    const browser = createBrowser({ createWorktree, openSelected, reload });

    browser.handleInput('right');
    browser.handleInput('w');
    for (const char of 'rh/feature') {
      browser.handleInput(char);
    }
    browser.handleInput('enter');

    await vi.waitFor(() => expect(createWorktree).toHaveBeenCalledTimes(1));
    const request = createWorktree.mock.calls[0]?.[0];
    expect(request).toMatchObject({
      branchName: 'rh/feature',
      repoIntent: {
        repoName: 'project',
        qualifiedRepoName: 'owner/project',
        candidateRuntimeIds: ['922f7ac8deadbeef'],
        preferredRuntimeId: '922f7ac8deadbeef',
      },
      launch: { mode: 'tmux-detached', agentDir: { mode: 'ambient' } },
    });
    expect(request).not.toHaveProperty('label');
    expect(openSelected).not.toHaveBeenCalled();
    await vi.waitFor(() => {
      const output = renderText(browser);
      expect(output).toContain('New Pi session launched on the generated worktree.');
      expect(output).not.toContain('Session ready · press o to attach.');
      expect(output).not.toContain('has not observed it yet');
    });
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('keeps partial launch failures retryable with kept-worktree copy', async () => {
    const createWorktree = vi.fn<
      NonNullable<ConstructorParameters<typeof SessionDeckBrowser>[0]['createWorktree']>
    >(async () => ({
      ok: false as const,
      status: 'partial-launch-failed' as const,
      failurePhase: 'launch' as const,
      worktree: {
        ok: true as const,
        status: 'created' as const,
        path: '/tmp/project-wt-feature',
        branch: 'rh/feature',
        baseRef: 'origin/main',
        repoName: 'project',
        qualifiedRepoName: 'owner/project',
        manualCommand: 'git worktree add ...',
      },
      worktreeRetained: true as const,
      launch: {
        requested: true as const,
        ok: false as const,
        mode: 'tmux-detached' as const,
        status: 'failed' as const,
        reason: 'spawn-failed' as const,
        recoverable: true,
        message: 'Created worktree, but tmux could not start Pi.',
      },
    }));
    const browser = createBrowser({ createWorktree });

    browser.handleInput('right');
    browser.handleInput('w');
    for (const char of 'rh/feature') {
      browser.handleInput(char);
    }
    browser.handleInput('enter');

    await vi.waitFor(() => expect(createWorktree).toHaveBeenCalledTimes(1));
    const output = renderText(browser);
    expect(output).toContain('Pi did not start.');
    expect(output).toContain('Tmux could not start Pi.');
    expect(output).toContain('The generated worktree was kept.');
    expect(output).toContain('Fix the issue, then press w to retry.');
  });

  it('requests iTerm2 focus for the selected public record with o and renders success as muted', async () => {
    const fg = vi.fn((_tone: string, text: string) => text);
    const openSelected = vi.fn(async (_record: SessionDeckRecord) => ({
      ok: true,
      message: 'Requested iTerm2 focus for selected session.',
    }));
    const browser = createBrowser({
      theme: createTheme({ fg }),
      openSelected,
      initialView: buildSnapshot({
        records: [
          buildSnapshotRecord({ runtimeId: 'rt-alpha', sessionName: 'alpha' }),
          buildSnapshotRecord({ runtimeId: 'rt-bravo', sessionName: 'bravo' }),
        ],
      }),
    });

    browser.handleInput('down');
    browser.handleInput('o');

    await vi.waitFor(() => expect(openSelected).toHaveBeenCalledTimes(1));
    const [openedRecord] = vi.mocked(openSelected).mock.calls[0] ?? [];
    expect(openedRecord?.runtimeId).toBe('rt-bravo');
    expect(openedRecord).not.toHaveProperty('terminal');

    await vi.waitFor(() => {
      expect(renderText(browser)).toContain('Requested iTerm2 focus for selected session.');
    });
    expect(
      vi
        .mocked(fg)
        .mock.calls.some(
          ([tone, text]) =>
            tone === 'muted' && text === 'Requested iTerm2 focus for selected session.',
        ),
    ).toBe(true);
  });

  it('does not launch duplicate open requests while one is pending', async () => {
    let resolveOpen: ((value: { ok: boolean; message: string }) => void) | null = null;
    const openSelected = vi.fn(
      async (_record: SessionDeckRecord) =>
        new Promise<{ ok: boolean; message: string }>((resolve) => {
          resolveOpen = resolve;
        }),
    );
    const browser = createBrowser({ openSelected });

    browser.handleInput('o');
    browser.handleInput('o');

    expect(openSelected).toHaveBeenCalledTimes(1);
    expect(renderText(browser)).toContain('Already opening terminal…');

    expect(resolveOpen).not.toBeNull();
    resolveOpen!({ ok: true, message: 'Requested iTerm2 focus for selected session.' });
    await vi.waitFor(() => {
      expect(renderText(browser)).toContain('Requested iTerm2 focus for selected session.');
    });
  });

  it('renders soft open failures as warning statuses', async () => {
    const fg = vi.fn((_tone: string, text: string) => text);
    const openSelected = vi.fn(async (_record: SessionDeckRecord) => ({
      ok: false,
      message: 'Terminal metadata is unavailable for selected session.',
    }));
    const browser = createBrowser({
      theme: createTheme({ fg }),
      openSelected,
    });

    browser.handleInput('o');

    await vi.waitFor(() => {
      expect(renderText(browser)).toContain(
        'Terminal metadata is unavailable for selected session.',
      );
    });
    expect(
      vi
        .mocked(fg)
        .mock.calls.some(
          ([tone, text]) =>
            tone === 'warning' && text === 'Terminal metadata is unavailable for selected session.',
        ),
    ).toBe(true);
  });

  it('converts thrown open callback errors into warning statuses', async () => {
    const fg = vi.fn((_tone: string, text: string) => text);
    const openSelected = vi.fn(async (_record: SessionDeckRecord) => {
      throw new Error('activation bridge crashed');
    });
    const browser = createBrowser({
      theme: createTheme({ fg }),
      openSelected,
    });

    browser.handleInput('o');

    await vi.waitFor(() => {
      expect(renderText(browser)).toContain('activation bridge crashed');
      expect(
        vi
          .mocked(fg)
          .mock.calls.some(
            ([tone, text]) => tone === 'warning' && text.includes('activation bridge crashed'),
          ),
      ).toBe(true);
    });
  });

  it('does not call the opener for an empty session list', () => {
    const openSelected = vi.fn(async (_record: SessionDeckRecord) => ({
      ok: true,
      message: 'Requested iTerm2 focus for selected session.',
    }));
    const browser = createBrowser({
      openSelected,
      initialView: buildSnapshot({ records: [] }),
    });

    browser.handleInput('o');

    expect(openSelected).not.toHaveBeenCalled();
  });

  it('opens an End session confirmation with k and only Enter confirms the frozen selected row', async () => {
    const killSelected = vi.fn(async (_record: SessionDeckRecord) => ({
      ok: true,
      message: 'End requested for this session.',
    }));
    const browser = createBrowser({
      killSelected,
      initialView: buildSnapshot({
        records: [
          buildSnapshotRecord({ runtimeId: 'rt-alpha', sessionName: 'alpha', pid: 111 }),
          buildSnapshotRecord({ runtimeId: 'rt-bravo', sessionName: 'bravo', pid: 222 }),
        ],
      }),
    });

    browser.handleInput('k');
    const killConfirmation = normalizeWhitespace(renderText(browser));
    expect(killConfirmation).toContain('End session for alpha (rt-alpha, pid 111)?');
    expect(killConfirmation).toContain(
      'Ending this session sends SIGTERM to the Pi runtime only. Session history is preserved.',
    );
    expect(killConfirmation).toContain('Enter confirm · esc/q cancel');
    expect(killSelected).not.toHaveBeenCalled();

    browser.handleInput('k');
    browser.handleInput('down');
    expect(killSelected).not.toHaveBeenCalled();

    browser.handleInput('enter');
    await vi.waitFor(() => expect(killSelected).toHaveBeenCalledTimes(1));
    const [stoppedRecord] = vi.mocked(killSelected).mock.calls[0] ?? [];
    expect(stoppedRecord?.runtimeId).toBe('rt-alpha');
    await vi.waitFor(() =>
      expect(renderText(browser)).toContain('End requested for this session.'),
    );
    expect(renderText(browser)).not.toContain('killed');
  });

  it('cancels End session confirmation with escape ctrl-c or q without stopping', () => {
    const killSelected = vi.fn(async (_record: SessionDeckRecord) => ({
      ok: true,
      message: 'End requested for this session.',
    }));
    const browser = createBrowser({ killSelected });

    for (const key of ['escape', 'ctrl+c', 'q']) {
      browser.handleInput('k');
      expect(renderText(browser)).toContain('End session for alpha');
      browser.handleInput(key);
      expect(renderText(browser)).toContain('End session cancelled.');
    }

    expect(killSelected).not.toHaveBeenCalled();
  });

  it('cancels End session confirmation when the target disappears on refresh', async () => {
    vi.useFakeTimers();
    const killSelected = vi.fn(async (_record: SessionDeckRecord) => ({
      ok: true,
      message: 'End requested for this session.',
    }));
    const reload = vi.fn(async () => buildSnapshot({ records: [] }));
    const browser = createBrowser({ killSelected, reload });

    browser.handleInput('k');
    await vi.advanceTimersByTimeAsync(15_000);

    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    expect(renderText(browser)).toContain(
      'End session cancelled; selected session is no longer visible.',
    );
    browser.handleInput('enter');
    expect(killSelected).not.toHaveBeenCalled();
  });

  it('renders End session failures as retryable warning statuses', async () => {
    const fg = vi.fn((_tone: string, text: string) => text);
    const killSelected = vi.fn(async (_record: SessionDeckRecord) => ({
      ok: false,
      message: 'Could not safely verify the selected process.',
    }));
    const browser = createBrowser({ theme: createTheme({ fg }), killSelected });

    browser.handleInput('k');
    browser.handleInput('enter');

    await vi.waitFor(() => {
      expect(renderText(browser)).toContain('Could not safely verify the selected process.');
    });
    expect(
      vi
        .mocked(fg)
        .mock.calls.some(
          ([tone, text]) =>
            tone === 'warning' && text === 'Could not safely verify the selected process.',
        ),
    ).toBe(true);
  });

  it('keeps auto-refresh running while an open request is pending', async () => {
    vi.useFakeTimers();

    let resolveOpen: ((value: { ok: boolean; message: string }) => void) | null = null;
    const openSelected = vi.fn(
      async (_record: SessionDeckRecord) =>
        new Promise<{ ok: boolean; message: string }>((resolve) => {
          resolveOpen = resolve;
        }),
    );
    const reload = vi.fn(async () =>
      buildSnapshot({ records: [buildSnapshotRecord({ sessionName: 'refreshed' })] }),
    );
    const browser = createBrowser({ openSelected, reload });

    browser.handleInput('o');
    await vi.advanceTimersByTimeAsync(15_000);

    expect(openSelected).toHaveBeenCalledTimes(1);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(renderText(browser)).toContain('refreshed');

    expect(resolveOpen).not.toBeNull();
    resolveOpen!({ ok: true, message: 'Requested iTerm2 focus for selected session.' });
    await Promise.resolve();
  });

  it('manual refreshes in place and preserves repo selection plus row selection', async () => {
    const requestRender = vi.fn();
    const reload = vi.fn<() => Promise<SessionDeckSnapshot>>().mockResolvedValue(
      buildSnapshot({
        records: [
          buildRepoRecord('rt-0', 'alpha-zero', 'alpha', 'org/alpha'),
          buildRepoRecord('rt-3', 'alpha-two refreshed', 'alpha', 'org/alpha', {
            pid: 303,
            sessionId: 'session-3',
            chips: ['queue 2'],
          }),
          buildRepoRecord('rt-4', 'gamma-one', 'gamma', 'org/gamma'),
        ],
      }),
    );
    const browser = createBrowser({
      requestRender,
      reload,
      initialView: buildSnapshot({
        records: [
          buildRepoRecord('rt-1', 'alpha-one', 'alpha', 'org/alpha'),
          buildRepoRecord('rt-2', 'beta-one', 'beta', 'org/beta', {
            pid: 202,
            sessionId: 'session-2',
          }),
          buildRepoRecord('rt-3', 'alpha-two', 'alpha', 'org/alpha', {
            pid: 303,
            sessionId: 'session-3',
          }),
        ],
      }),
    });

    browser.handleInput('down');
    browser.handleInput('down');
    browser.handleInput('right');
    browser.handleInput('r');

    await vi.waitFor(() => {
      expect(reload).toHaveBeenCalledTimes(1);
      const output = renderText(browser);
      expect(output).toContain('  ○ idle  alpha-zero  alpha · #1 · 5s · main');
      expect(output).toContain('› ○ idle  alpha-two refreshed  alpha · #1 · 5s · main');
      expect(output).toContain('│ alpha-two refreshed');
      expect(output).not.toContain('beta-one');
      expect(output).not.toContain('gamma-one');
    });

    expect(requestRender).toHaveBeenCalled();
  });

  it('manual refresh preserves selection against the visible subset when temp rows are present', async () => {
    const reload = vi.fn<() => Promise<SessionDeckSnapshot>>().mockResolvedValue(
      buildSnapshot({
        records: [
          buildRepoRecord('rt-temp-alpha-next', 'temp-alpha-next', 'alpha', 'org/alpha', {
            derivedFacets: buildDerivedFacets('ephemeral_child_runtime'),
          }),
          buildRepoRecord('rt-alpha-1', 'alpha-one refreshed', 'alpha', 'org/alpha'),
          buildRepoRecord('rt-alpha-2', 'alpha-two refreshed', 'alpha', 'org/alpha', {
            pid: 202,
            sessionId: 'session-alpha-2',
          }),
          buildRepoRecord('rt-gamma', 'gamma-one', 'gamma', 'org/gamma'),
        ],
      }),
    );
    const browser = createBrowser({
      reload,
      initialView: buildSnapshot({
        records: [
          buildRepoRecord('rt-alpha-1', 'alpha-one', 'alpha', 'org/alpha'),
          buildRepoRecord('rt-temp-alpha', 'temp-alpha', 'alpha', 'org/alpha', {
            derivedFacets: buildDerivedFacets('ephemeral_child_runtime'),
          }),
          buildRepoRecord('rt-alpha-2', 'alpha-two', 'alpha', 'org/alpha', {
            pid: 202,
            sessionId: 'session-alpha-2',
          }),
          buildRepoRecord('rt-beta', 'beta-one', 'beta', 'org/beta'),
        ],
      }),
    });

    browser.handleInput('right');
    browser.handleInput('down');
    browser.handleInput('r');

    await vi.waitFor(() => {
      expect(reload).toHaveBeenCalledTimes(1);
      const output = renderText(browser);
      expect(output).toContain('Pi sessions · 3 live');
      expect(output).toContain('  ○ idle  alpha-one refreshed  alpha · #1 · 5s · main');
      expect(output).toContain('› ○ idle  alpha-two refreshed  alpha · #1 · 5s · main');
      expect(output).toContain('│ alpha-two refreshed');
      expect(output).not.toContain('temp-alpha-next');
      expect(output).not.toContain('gamma-one');
    });
  });

  it('preserves the active repo when refresh enriches it with a first qualified identity', async () => {
    const reload = vi.fn<() => Promise<SessionDeckSnapshot>>().mockResolvedValue(
      buildSnapshot({
        records: [
          buildRepoRecord('rt-alpha-1', 'alpha-one refreshed', 'alpha', 'owner/alpha'),
          buildRepoRecord('rt-alpha-2', 'alpha-two refreshed', 'alpha', 'owner/alpha', {
            pid: 202,
            sessionId: 'session-alpha-2',
          }),
          buildRepoRecord('rt-beta', 'beta-one', 'beta', 'org/beta'),
        ],
      }),
    );
    const browser = createBrowser({
      reload,
      initialView: buildSnapshot({
        records: [
          buildRepoRecord('rt-alpha-1', 'alpha-one', 'alpha', null),
          buildRepoRecord('rt-alpha-2', 'alpha-two', 'alpha', null, {
            pid: 202,
            sessionId: 'session-alpha-2',
          }),
          buildRepoRecord('rt-beta', 'beta-one', 'beta', 'org/beta'),
        ],
      }),
    });

    browser.handleInput('right');
    browser.handleInput('down');
    browser.handleInput('r');

    await vi.waitFor(() => {
      expect(reload).toHaveBeenCalledTimes(1);
      const output = renderText(browser);
      expect(output).toContain('  ○ idle  alpha-one refreshed  alpha · #1 · 5s · main');
      expect(output).toContain('› ○ idle  alpha-two refreshed  alpha · #1 · 5s · main');
      expect(output).toContain('│ alpha-two refreshed');
      expect(output).not.toContain('beta-one');
    });
  });

  it('auto-refreshes every 15s, stays silent on success, and preserves repo selection plus row selection', async () => {
    vi.useFakeTimers();

    const requestRender = vi.fn();
    const reload = vi.fn<() => Promise<SessionDeckSnapshot>>().mockResolvedValue(
      buildSnapshot({
        records: [
          buildRepoRecord('rt-0', 'alpha-zero', 'alpha', 'org/alpha'),
          buildRepoRecord('rt-3', 'alpha-two refreshed', 'alpha', 'org/alpha', {
            pid: 303,
            sessionId: 'session-3',
            chips: ['queue 2'],
          }),
          buildRepoRecord('rt-4', 'gamma-one', 'gamma', 'org/gamma'),
        ],
      }),
    );
    const browser = createBrowser({
      requestRender,
      reload,
      initialView: buildSnapshot({
        records: [
          buildRepoRecord('rt-1', 'alpha-one', 'alpha', 'org/alpha'),
          buildRepoRecord('rt-2', 'beta-one', 'beta', 'org/beta', {
            pid: 202,
            sessionId: 'session-2',
          }),
          buildRepoRecord('rt-3', 'alpha-two', 'alpha', 'org/alpha', {
            pid: 303,
            sessionId: 'session-3',
          }),
        ],
      }),
    });

    browser.handleInput('down');
    browser.handleInput('down');
    browser.handleInput('right');
    requestRender.mockClear();

    await vi.advanceTimersByTimeAsync(15_000);

    expect(reload).toHaveBeenCalledTimes(1);
    const output = renderText(browser);
    expect(output).toContain('  ○ idle  alpha-zero  alpha · #1 · 5s · main');
    expect(output).toContain('› ○ idle  alpha-two refreshed  alpha · #1 · 5s · main');
    expect(output).toContain('│ alpha-two refreshed');
    expect(output).not.toContain('beta-one');
    expect(output).not.toContain('gamma-one');
    expect(output).not.toContain('Refreshing session deck…');
    expect(output).not.toContain('Auto refresh failed:');
    expect(requestRender).toHaveBeenCalled();
  });

  it('falls back to all when the active repo disappears on refresh', async () => {
    const reload = vi.fn<() => Promise<SessionDeckSnapshot>>().mockResolvedValue(
      buildSnapshot({
        records: [
          buildRepoRecord('rt-0', 'alpha-zero', 'alpha', 'org/alpha'),
          buildRepoRecord('rt-4', 'gamma-one', 'gamma', 'org/gamma'),
        ],
      }),
    );
    const browser = createBrowser({
      reload,
      initialView: buildSnapshot({
        records: [
          buildRepoRecord('rt-1', 'alpha-one', 'alpha', 'org/alpha'),
          buildRepoRecord('rt-2', 'beta-one', 'beta', 'org/beta', {
            pid: 202,
            sessionId: 'session-2',
          }),
        ],
      }),
    });

    browser.handleInput('right');
    browser.handleInput('right');
    browser.handleInput('r');

    await vi.waitFor(() => {
      expect(reload).toHaveBeenCalledTimes(1);
      const output = renderText(browser);
      expect(output).toContain('› ○ idle  alpha-zero  alpha · #1 · 5s · main');
      expect(output).toContain('  ○ idle  gamma-one  gamma · #1 · 5s · main');
      expect(output).toContain('│ alpha-zero');
      expect(output).not.toContain('beta-one');
    });
  });

  it('coalesces overlapping auto-refresh ticks', async () => {
    vi.useFakeTimers();

    const requestRender = vi.fn();
    const reload = vi.fn(
      () =>
        new Promise<SessionDeckSnapshot>((resolve) => {
          setTimeout(() => {
            resolve(
              buildSnapshot({
                records: [buildSnapshotRecord({ sessionName: 'beta', chips: ['queue 2'] })],
              }),
            );
          }, 20_000);
        }),
    );
    const browser = createBrowser({ requestRender, reload });

    await vi.advanceTimersByTimeAsync(15_000);

    expect(reload).toHaveBeenCalledTimes(1);
    expect(renderText(browser)).not.toContain('Refreshing session deck…');

    await vi.advanceTimersByTimeAsync(15_000);

    expect(reload).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5_000);

    expect(renderText(browser)).toContain('› ○ idle  beta  project · #42 · 5s · main');
    expect(requestRender).toHaveBeenCalledTimes(1);
  });

  it('uses the latest repo and row selection when refresh completes after in-flight navigation', async () => {
    let resolveReload: ((snapshot: SessionDeckSnapshot) => void) | null = null;
    const reload = vi.fn(
      () =>
        new Promise<SessionDeckSnapshot>((resolve) => {
          resolveReload = resolve;
        }),
    );
    const browser = createBrowser({
      reload,
      initialView: buildSnapshot({
        records: [
          buildRepoRecord('rt-alpha', 'alpha-one', 'alpha', 'org/alpha'),
          buildRepoRecord('rt-beta-1', 'beta-one', 'beta', 'org/beta', {
            pid: 202,
            sessionId: 'session-beta-1',
          }),
          buildRepoRecord('rt-beta-2', 'beta-two', 'beta', 'org/beta', {
            pid: 303,
            sessionId: 'session-beta-2',
          }),
        ],
      }),
    });

    browser.handleInput('r');
    browser.handleInput('right');
    browser.handleInput('right');
    browser.handleInput('down');

    expect(resolveReload).not.toBeNull();
    resolveReload!(
      buildSnapshot({
        records: [
          buildRepoRecord('rt-alpha', 'alpha-one refreshed', 'alpha', 'org/alpha'),
          buildRepoRecord('rt-beta-1', 'beta-one refreshed', 'beta', 'org/beta', {
            pid: 202,
            sessionId: 'session-beta-1',
          }),
          buildRepoRecord('rt-beta-2', 'beta-two refreshed', 'beta', 'org/beta', {
            pid: 303,
            sessionId: 'session-beta-2',
          }),
          buildRepoRecord('rt-gamma', 'gamma-one', 'gamma', 'org/gamma'),
        ],
      }),
    );

    await vi.waitFor(() => {
      expect(reload).toHaveBeenCalledTimes(1);
      const output = renderText(browser);
      expect(output).toContain('  ○ idle  beta-one refreshed  beta · #1 · 5s · main');
      expect(output).toContain('› ○ idle  beta-two refreshed  beta · #1 · 5s · main');
      expect(output).toContain('│ beta-two refreshed');
      expect(output).not.toContain('alpha-one refreshed');
      expect(output).not.toContain('gamma-one');
    });
  });

  it('keeps auto-refresh failure UI muted', async () => {
    vi.useFakeTimers();

    const fg = vi.fn((_tone: string, text: string) => text);
    const browser = createBrowser({
      theme: createTheme({ fg }),
      reload: vi.fn(async () => {
        throw new Error('network down');
      }),
    });

    await vi.advanceTimersByTimeAsync(15_000);

    const output = renderText(browser);
    expect(output).toContain('Auto refresh failed: network down');
    expect(output).not.toContain('Refreshing session deck…');
    expect(
      vi
        .mocked(fg)
        .mock.calls.some(
          ([tone, text]) => tone === 'muted' && text === 'Auto refresh failed: network down',
        ),
    ).toBe(true);
  });

  it('stops auto-refresh after dispose', async () => {
    vi.useFakeTimers();

    const reload = vi.fn(async () => buildSnapshot({ records: [buildSnapshotRecord()] }));
    const browser = createBrowser({ reload });

    browser.dispose();
    await vi.advanceTimersByTimeAsync(45_000);

    expect(reload).not.toHaveBeenCalled();
  });

  it('clips branch first on narrow top-pane line 1 and width-truncates the joined chip preview', () => {
    const browser = createBrowser({
      initialView: buildSnapshot({
        records: [
          buildSnapshotRecord({
            branch: 'rh-pr21733-pr5-docs-config-fixture-hygiene-and-session-deck-cleanup',
            chips: ['merge-ready clean', 'queue 2', 'needs-review soon'],
          }),
        ],
      }),
    });

    browser.handleInput('enter');
    const output = renderText(browser, 44);

    expect(output).toContain('› ○ idle  alpha  project · #42 · 5s');
    expect(output).not.toContain('session-deck-cleanup');
    expect(output).toContain('merge-ready clean · queue 2');
    expect(output).not.toContain('needs-review soon');
  });

  it('wraps the compact selected card cleanly at narrow widths', () => {
    const browser = createBrowser({
      all: true,
      showIdentity: true,
      initialView: buildSnapshot({
        records: [
          buildSnapshotRecord({
            runtimeId: 'rt-long',
            sessionName: 'a very long session name that should wrap cleanly in the detail pane',
            cwd: `${HOME}/really/long/path/that/should/be/wrapped/in/the/selected/card`,
            branch: 'rh-pr21733-pr5-docs-config-fixture-hygiene-and-session-deck-cleanup',
            activityState: 'error',
            activityAgeMs: 42_000,
            heartbeatAgeMs: 240_000,
            presenceState: 'stale',
            presenceReason: 'heartbeat_expired',
            lastError: 'tool bash failed because the selected row is intentionally oversized',
            chips: ['merge-ready clean', 'queue 2', 'needs-review soon'],
            diagnostics: [{ code: 'activity_stale', message: 'Activity record is stale' }],
          }),
        ],
      }),
    });

    const lines = renderLines(browser, 38);
    const boxedContentLines = lines.filter((line) => line.startsWith('│ '));

    expect(lines.every((line) => visibleWidth(line) <= 38)).toBe(true);
    expect(boxedContentLines.length).toBeGreaterThan(9);
    expect(boxedContentLines.some((line) => line.includes('chips:'))).toBe(true);
    expect(boxedContentLines.some((line) => line.includes('diagnostics:'))).toBe(true);
  });

  it('keeps every rendered line within the requested width', () => {
    const browser = createBrowser({
      showIdentity: true,
      initialView: buildSnapshot({
        records: [
          buildSnapshotRecord({
            runtimeId: 'rt-long',
            sessionName: 'a very long session name that should wrap cleanly in the detail pane',
            cwd: `${HOME}/really/long/path/that/should/be/truncated/for/the/list/but/wrapped/in/detail`,
            branch: 'rh-pr21733-pr5-docs-config-fixture-hygiene-and-session-deck-cleanup',
            lastError: 'tool bash failed because the selected row is intentionally oversized',
            activityState: 'error',
            chips: ['merge-ready clean', 'queue 2'],
          }),
        ],
      }),
      reapLines: ['Reap complete: removed 10 expired presence records.'],
    });

    const lines = renderLines(browser, 40);

    expect(lines.length).toBeGreaterThan(0);
    expect(lines.every((line) => visibleWidth(line) <= 40)).toBe(true);
  });
});

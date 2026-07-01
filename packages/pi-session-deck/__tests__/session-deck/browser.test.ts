import { afterEach, describe, expect, it, vi } from 'vitest';
import { visibleWidth } from '@mariozechner/pi-tui';
import type { Theme } from '@earendil-works/pi-coding-agent';

vi.mock('@mariozechner/pi-tui', async () => {
  const actual =
    await vi.importActual<typeof import('@mariozechner/pi-tui')>('@mariozechner/pi-tui');

  return {
    ...actual,
    matchesKey: (data: string, key: string) => {
      if ((key === 'enter' || key === 'return') && data === 'enter') {
        return true;
      }
      return data === key;
    },
  };
});

import { SessionDeckBrowser } from '../../extensions/session-deck/browser.js';
import type {
  SessionDeckRecord,
  SessionDeckSnapshot,
} from '../../extensions/session-deck/types.js';

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
    theme: overrides.theme ?? createTheme(),
  });

  openBrowsers.push(browser);
  return browser;
}

describe('SessionDeckBrowser', () => {
  it('renders the empty-state fallback', () => {
    const browser = createBrowser({
      initialView: buildSnapshot({ records: [] }),
    });

    expect(renderText(browser)).toContain('No live or stale Pi sessions found.');
  });

  it('renders reap summary lines above the browser list when provided', () => {
    const browser = createBrowser({
      reapLines: ['Reap complete: removed 1 expired presence record.', 'Removed:', '- rt-expired'],
    });

    const output = renderText(browser);

    expect(output).toContain('Reap complete: removed 1 expired presence record.');
    expect(output).toContain('Removed:');
    expect(output).toContain('- rt-expired');
    expect(output).toContain('› ● idle  alpha  project · #42 · 5s · main');
  });

  it('keeps the top-pane dashboard unchanged and shows session ids by default only in the selected card', () => {
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
    expect(output).toContain('› ● idle  alpha  project · #42 · 5s · main');
    expect(output).toContain('  │ merge-ready clean · queue 2');
    expect(output).toContain('  ◌ thinking  bravo  project · #42 · 4m · main');
    expect(output).toContain('    no chips');
    expect(output).toContain(
      '  │ merge-ready clean · queue 2\n\n  ◌ thinking  bravo  project · #42 · 4m · main',
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

    expect(renderText(browser)).toContain('› ● idle  repo-one  5s');
    expect(renderText(browser)).toContain('│ repo-one');
    expect(renderText(browser)).toContain('│ repo: owner/repo-one');
    expect(renderText(browser)).toContain('│ cwd: ~/repo-one/packages/cli');

    browser.handleInput('down');

    let output = renderText(browser);
    expect(output).toContain('› ● idle  worker  5s');
    expect(output).toContain('│ worker');
    expect(output).toContain('│ cwd: ~/scratch/worker');

    browser.handleInput('down');

    output = renderText(browser);
    expect(output).toContain('› ● idle  abcdef12  5s');
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
    expect(selectedOutput).toContain('› ◌ thinking  bravo  project · #42 · 4m · main');
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
      dimmedText.some((text) => text.includes('◌ thinking  bravo  project · #42 · 4m · main')),
    ).toBe(true);
    expect(
      dimmedText.some((text) => text.includes('× unknown  charlie  project · #42 · 9m · main')),
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

    expect(accentText.some((text) => text.includes('› ● idle  alpha'))).toBe(true);
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

  it('manual refreshes in place and preserves selection by runtime id', async () => {
    const requestRender = vi.fn();
    const reload = vi.fn<() => Promise<SessionDeckSnapshot>>().mockResolvedValue(
      buildSnapshot({
        records: [
          buildSnapshotRecord({
            runtimeId: 'rt-3',
            pid: 303,
            sessionId: 'session-3',
            sessionName: 'charlie',
          }),
          buildSnapshotRecord({
            runtimeId: 'rt-2',
            pid: 202,
            sessionId: 'session-2',
            sessionName: 'beta',
            chips: ['queue 2'],
          }),
        ],
      }),
    );
    const browser = createBrowser({
      requestRender,
      reload,
      initialView: buildSnapshot({
        records: [
          buildSnapshotRecord({ sessionName: 'alpha' }),
          buildSnapshotRecord({
            runtimeId: 'rt-2',
            pid: 202,
            sessionId: 'session-2',
            sessionName: 'bravo',
            chips: [],
          }),
        ],
      }),
    });

    browser.handleInput('down');
    browser.handleInput('r');

    await vi.waitFor(() => {
      expect(reload).toHaveBeenCalledTimes(1);
      const output = renderText(browser);
      expect(output).toContain('  ● idle  charlie  project · #42 · 5s · main');
      expect(output).toContain('› ● idle  beta  project · #42 · 5s · main');
    });

    expect(requestRender).toHaveBeenCalled();
  });

  it('auto-refreshes every 15s, stays silent on success, and preserves selection by runtime id', async () => {
    vi.useFakeTimers();

    const requestRender = vi.fn();
    const reload = vi.fn<() => Promise<SessionDeckSnapshot>>().mockResolvedValue(
      buildSnapshot({
        records: [
          buildSnapshotRecord({
            runtimeId: 'rt-3',
            pid: 303,
            sessionId: 'session-3',
            sessionName: 'charlie',
          }),
          buildSnapshotRecord({
            runtimeId: 'rt-2',
            pid: 202,
            sessionId: 'session-2',
            sessionName: 'beta',
            chips: ['queue 2'],
          }),
        ],
      }),
    );
    const browser = createBrowser({
      requestRender,
      reload,
      initialView: buildSnapshot({
        records: [
          buildSnapshotRecord({ sessionName: 'alpha' }),
          buildSnapshotRecord({
            runtimeId: 'rt-2',
            pid: 202,
            sessionId: 'session-2',
            sessionName: 'bravo',
            chips: [],
          }),
        ],
      }),
    });

    browser.handleInput('down');
    requestRender.mockClear();

    await vi.advanceTimersByTimeAsync(15_000);

    expect(reload).toHaveBeenCalledTimes(1);
    const output = renderText(browser);
    expect(output).toContain('  ● idle  charlie  project · #42 · 5s · main');
    expect(output).toContain('› ● idle  beta  project · #42 · 5s · main');
    expect(output).not.toContain('Refreshing session deck…');
    expect(output).not.toContain('Auto refresh failed:');
    expect(requestRender).toHaveBeenCalled();
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

    expect(renderText(browser)).toContain('› ● idle  beta  project · #42 · 5s · main');
    expect(requestRender).toHaveBeenCalledTimes(1);
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

    expect(output).toContain('› ● idle  alpha  project · #42 · 5s');
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

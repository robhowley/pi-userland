import { describe, expect, it, vi } from 'vitest';
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
    cwd: `${HOME}/project`,
    branch: 'main',
    prUrl: 'https://github.com/owner/repo/pull/42',
    activityState: 'waiting',
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

function renderText(browser: SessionDeckBrowser, width = 120): string {
  return browser.render(width).join('\n');
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
  return new SessionDeckBrowser({
    all: overrides.all ?? false,
    showIdentity: overrides.showIdentity ?? false,
    initialView: overrides.initialView ?? buildSnapshot(),
    onClose: overrides.onClose ?? (() => {}),
    reload: overrides.reload ?? (async () => overrides.initialView ?? buildSnapshot()),
    requestRender: overrides.requestRender ?? (() => {}),
    ...(overrides.reapLines === undefined ? {} : { reapLines: overrides.reapLines }),
    theme: overrides.theme ?? createTheme(),
  });
}

describe('SessionDeckBrowser', () => {
  it('renders the empty-state fallback', () => {
    const browser = createBrowser({
      initialView: buildSnapshot({ records: [] }),
    });

    expect(renderText(browser)).toContain('No live or stale Pi sessions found.');
  });

  it('renders count-aware two-line rows and a boxed selected card', () => {
    const browser = createBrowser({
      all: true,
      showIdentity: true,
      initialView: buildSnapshot({
        records: [
          buildSnapshotRecord({ chips: ['merge-ready clean', 'queue 2'] }),
          buildSnapshotRecord({
            runtimeId: 'rt-2',
            pid: 202,
            sessionId: 'session-2',
            sessionName: 'bravo',
            presenceState: 'stale',
            presenceReason: 'heartbeat_expired',
            activityState: 'thinking',
            activityAgeMs: 180_000,
            chips: [],
          }),
        ],
      }),
    });

    const output = renderText(browser);

    expect(output).toContain('Pi sessions · 1 live · 1 stale · 0 dead · 0 unknown');
    expect(output).toContain('› ● waiting  alpha');
    expect(output).toContain('    project · main · #42 · 5s');
    expect(output).toContain('  ◌ thinking  bravo');
    expect(output).toContain('    project · main · #42 · 3m');
    expect(output).toContain('Selected session');
    expect(output).toContain('┌');
    expect(output).toContain('│ alpha');
    expect(output).toContain('│ repo: project');
    expect(output).toContain('│ cwd: ~/project');
    expect(output).toContain('│ presence: ● live');
    expect(output).toContain('│ activity: waiting');
    expect(output).toContain('│ chips:');
    expect(output).toContain('│   - merge-ready clean');
    expect(output).toContain('│   - queue 2');
    expect(output).toContain('│ heartbeat: 5s ago');
    expect(output).toContain('│ runtime: 922f7ac8deadbeef · pid: 101');
    expect(output).toContain('│ session: session-abc');
    expect(output).not.toContain('\n  merge-ready clean\n');
  });

  it('uses session name, then cwd/repo, then runtime id in both the list and selected card', () => {
    const browser = createBrowser({
      initialView: buildSnapshot({
        records: [
          buildSnapshotRecord({
            sessionName: null,
            cwd: `${HOME}/repo-one`,
            branch: null,
            prUrl: null,
          }),
          buildSnapshotRecord({
            runtimeId: 'abcdef1234567890',
            pid: 303,
            sessionName: null,
            cwd: null,
            branch: null,
            prUrl: null,
          }),
        ],
      }),
    });

    expect(renderText(browser)).toContain('› ● waiting  repo-one');
    expect(renderText(browser)).toContain('│ repo-one');

    browser.handleInput('down');

    const output = renderText(browser);
    expect(output).toContain('› ● waiting  abcdef12');
    expect(output).toContain('│ abcdef12');
    expect(output).toContain('│ runtime: abcdef1234567890 · pid: 303');
  });

  it('moves selection and toggles the detail pane', () => {
    const requestRender = vi.fn();
    const browser = createBrowser({
      requestRender,
      showIdentity: true,
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
            activityState: 'thinking',
            activityAgeMs: 180_000,
            chips: ['queue 2'],
          }),
        ],
      }),
    });

    browser.handleInput('down');

    expect(requestRender).toHaveBeenCalledTimes(1);
    const selectedOutput = renderText(browser);
    expect(selectedOutput).toContain('› ◌ thinking  bravo');
    expect(selectedOutput).toContain('│ presence: ◌ stale');
    expect(selectedOutput).toContain('│ activity: thinking · 3m');
    expect(selectedOutput).toContain('│ session: session-2');

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
            activityState: 'thinking',
            activityAgeMs: 180_000,
          }),
          buildSnapshotRecord({
            runtimeId: 'rt-3',
            sessionName: 'charlie',
            presenceState: 'dead',
            presenceReason: 'pid_missing',
            activityState: 'unknown',
          }),
        ],
      }),
    });

    browser.render(120);

    const dimmedText = vi
      .mocked(fg)
      .mock.calls.filter(([tone]) => tone === 'dim')
      .map(([, text]) => text);

    expect(dimmedText.some((text) => text.includes('◌ thinking  bravo'))).toBe(true);
    expect(dimmedText.some((text) => text.includes('× unknown  charlie'))).toBe(true);
  });

  it('closes on q and escape', () => {
    const onClose = vi.fn();
    const browser = createBrowser({ onClose });

    browser.handleInput('q');
    browser.handleInput('escape');

    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('refreshes in place without losing selection', async () => {
    const requestRender = vi.fn();
    const reload = vi.fn<() => Promise<SessionDeckSnapshot>>().mockResolvedValue(
      buildSnapshot({
        records: [
          buildSnapshotRecord({
            runtimeId: 'rt-2',
            pid: 202,
            sessionId: 'session-2',
            sessionName: 'bravo',
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
          buildSnapshotRecord({
            runtimeId: 'rt-2',
            pid: 202,
            sessionId: 'session-2',
            sessionName: 'alpha',
          }),
        ],
      }),
    });

    browser.handleInput('r');

    await vi.waitFor(() => {
      expect(reload).toHaveBeenCalledTimes(1);
      expect(renderText(browser)).toContain('› ● waiting  bravo');
    });

    expect(requestRender).toHaveBeenCalled();
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
          }),
        ],
      }),
      reapLines: ['Reap complete: removed 10 expired presence records.'],
    });

    const lines = browser.render(40);

    expect(lines.length).toBeGreaterThan(0);
    expect(lines.every((line) => visibleWidth(line) <= 40)).toBe(true);
  });
});

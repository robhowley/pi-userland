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

function createTheme(): Theme {
  return {
    bold: (text: string) => text,
    fg: (_tone: string, text: string) => text,
  } as Theme;
}

function buildSnapshotRecord(overrides: Partial<SessionDeckRecord> = {}): SessionDeckRecord {
  return {
    runtimeId: '922f7ac8deadbeef',
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
    theme: createTheme(),
  });
}

describe('SessionDeckBrowser', () => {
  it('renders the empty-state fallback', () => {
    const browser = createBrowser({
      initialView: buildSnapshot({ records: [] }),
    });

    expect(renderText(browser)).toContain('No live or stale Pi sessions found.');
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
            sessionId: 'session-2',
            sessionName: 'bravo',
            activityState: 'thinking',
            activityAgeMs: 180_000,
            chips: ['queue 2'],
          }),
        ],
      }),
    });

    browser.handleInput('down');

    expect(requestRender).toHaveBeenCalledTimes(1);
    expect(renderText(browser)).toContain('rt-2  thinking 3m  5s');
    expect(renderText(browser)).toContain('  bravo');
    expect(renderText(browser)).toContain('  session=session-2');

    browser.handleInput('enter');

    expect(renderText(browser)).toContain('Detail hidden');
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
        records: [buildSnapshotRecord({ runtimeId: 'rt-2', sessionName: 'alpha' })],
      }),
    });

    browser.handleInput('r');

    await vi.waitFor(() => {
      expect(reload).toHaveBeenCalledTimes(1);
      expect(renderText(browser)).toContain('  bravo');
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

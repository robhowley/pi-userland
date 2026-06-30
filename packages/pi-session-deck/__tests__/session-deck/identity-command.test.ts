import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  parseSessionDeckCommandArgs,
  registerSessionDeckCommand,
  SESSION_DECK_COMMAND_NAME,
} from '../../extensions/session-deck/identity/command.js';
import type {
  PresenceCommandAPI,
  PresenceCommandContext,
  PresenceCommandRegistration,
} from '../../extensions/session-deck/identity/command.js';
import type {
  SessionDeckDiagnostic,
  SessionDeckRecord,
  SessionDeckSnapshot,
} from '../../extensions/session-deck/types.js';

const HOME = process.env['HOME'] ?? '/home/user';

afterEach(() => {
  vi.useRealTimers();
});

function createMockAPI(): {
  api: PresenceCommandAPI;
  getHandler: () => ((args: string, ctx: PresenceCommandContext) => Promise<void>) | undefined;
  getRegistration: () => PresenceCommandRegistration | undefined;
} {
  const api = {
    registerCommand: vi.fn(),
  } satisfies PresenceCommandAPI;

  return {
    api,
    getHandler: () => vi.mocked(api.registerCommand).mock.calls[0]?.[1].handler,
    getRegistration: () => vi.mocked(api.registerCommand).mock.calls[0]?.[1],
  };
}

function createTheme() {
  return {
    bold: (text: string) => text,
    fg: (_tone: string, text: string) => text,
  };
}

function createCommandContext(
  overrides: Partial<PresenceCommandContext> = {},
): PresenceCommandContext {
  const custom = vi.fn() as NonNullable<PresenceCommandContext['ui']['custom']>;
  const overrideUi = overrides.ui ?? {};

  return {
    ...(overrides.mode === undefined ? {} : { mode: overrides.mode }),
    ...overrides,
    ui: {
      notify: vi.fn(),
      custom,
      ...overrideUi,
    },
  };
}

function buildSnapshotRecord(overrides: Partial<SessionDeckRecord> = {}): SessionDeckRecord {
  return {
    runtimeId: '922f7ac8deadbeef',
    pid: 101,
    presenceState: 'live',
    presenceReason: 'fresh_heartbeat',
    heartbeatAgeMs: 5_000,
    sessionId: 'session-abc',
    sessionName: null,
    repoName: 'project',
    cwd: `${HOME}/project`,
    branch: 'main',
    prUrl: 'https://github.com/owner/repo/pull/42',
    isLinkedWorktree: false,
    worktreeLabel: null,
    activityState: 'waiting',
    activityAgeMs: null,
    currentToolName: null,
    lastError: null,
    chips: [],
    diagnostics: [],
    ...overrides,
  };
}

function buildSnapshot(
  options: {
    records?: SessionDeckRecord[];
    diagnostics?: SessionDeckDiagnostic[];
  } = {},
): SessionDeckSnapshot {
  return {
    generatedAt: '2026-06-17T12:10:00.000Z',
    records: options.records ?? [buildSnapshotRecord()],
    diagnostics: options.diagnostics ?? [],
  };
}

describe('session-deck joined command', () => {
  it('parses strict flag combinations', () => {
    expect(parseSessionDeckCommandArgs('')).toEqual({
      ok: true,
      all: false,
      reap: false,
      identity: false,
    });
    expect(parseSessionDeckCommandArgs('--all')).toEqual({
      ok: true,
      all: true,
      reap: false,
      identity: false,
    });
    expect(parseSessionDeckCommandArgs('--reap --identity')).toEqual({
      ok: true,
      all: false,
      reap: true,
      identity: true,
    });
    expect(parseSessionDeckCommandArgs('--all --reap --identity')).toEqual({
      ok: true,
      all: true,
      reap: true,
      identity: true,
    });
    expect(parseSessionDeckCommandArgs('--identity --identity')).toEqual({
      ok: false,
      message: 'Usage: /session-deck [--all] [--reap] [--identity]',
    });
  });

  it('offers --all, --reap, and --identity completions', () => {
    const { api, getRegistration } = createMockAPI();

    registerSessionDeckCommand(api, {
      readSessionDeckSnapshot: vi.fn(async () => buildSnapshot({ records: [] })),
    });

    expect(getRegistration()?.getArgumentCompletions?.('')).toEqual([
      { value: '--all', label: '--all' },
      { value: '--reap', label: '--reap' },
      { value: '--identity', label: '--identity' },
    ]);
  });

  it('renders the scannable multi-line shape and keeps diagnostics in all mode', async () => {
    const { api, getHandler } = createMockAPI();
    const readSessionDeckSnapshot = vi.fn(async () =>
      buildSnapshot({
        records: [
          buildSnapshotRecord({ sessionName: 'alpha', chips: ['merge-ready clean'] }),
          buildSnapshotRecord({
            runtimeId: 'rt-2',
            presenceState: 'stale',
            presenceReason: 'heartbeat_expired',
            heartbeatAgeMs: 180_000,
            activityState: 'thinking',
            activityAgeMs: 180_000,
            chips: [],
          }),
          buildSnapshotRecord({
            runtimeId: 'rt-3',
            activityState: 'tool-running',
            activityAgeMs: 42_000,
            currentToolName: 'read',
            chips: ['status syncing', 'queue 2'],
          }),
          buildSnapshotRecord({
            runtimeId: 'rt-4',
            activityState: 'error',
            lastError: 'tool bash failed',
          }),
          buildSnapshotRecord({
            runtimeId: 'rt-6',
            cwd: `${HOME}/scratch`,
            branch: null,
            prUrl: null,
          }),
          buildSnapshotRecord({
            runtimeId: 'rt-5',
            presenceState: 'dead',
            presenceReason: 'pid_missing',
            activityState: 'unknown',
            diagnostics: [{ code: 'activity_stale', message: 'Activity record is stale' }],
            chips: ['session warning'],
          }),
        ],
        diagnostics: [
          {
            code: 'malformed_activity_record',
            message: 'Ignored malformed activity record',
            runtimeId: 'rt-5',
          },
        ],
      }),
    );

    registerSessionDeckCommand(api, {
      readSessionDeckSnapshot,
    });

    const handler = getHandler();
    const ctx = createCommandContext({ mode: 'rpc' });

    await handler?.('', ctx);
    const [defaultMessage] = vi.mocked(ctx.ui.notify).mock.calls[0] ?? [];
    expect(defaultMessage).toContain('Pi sessions (live + stale)');
    expect(defaultMessage).toContain('922f7ac8  waiting  5s');
    expect(defaultMessage).toContain('  alpha');
    expect(defaultMessage).toContain('  project  main  #42');
    expect(defaultMessage).toContain('  merge-ready clean');
    expect(defaultMessage).toContain('rt-2  thinking 3m  3m  stale  reason=heartbeat_expired');
    expect(defaultMessage).toContain('rt-3  tool-running: read 42s  5s');
    expect(defaultMessage).toContain('  status syncing | queue 2');
    expect(defaultMessage).toContain('rt-4  error: tool bash failed  5s');
    expect(defaultMessage).toContain('  ~/scratch');
    expect(defaultMessage).not.toContain('rt-5');
    expect(defaultMessage).not.toContain('presence=live');
    expect(defaultMessage).not.toContain('reason=fresh_heartbeat');
    expect(defaultMessage).not.toContain('chips=');
    expect(defaultMessage).not.toContain('scope=');
    expect(defaultMessage).not.toContain('updatedAt=');

    vi.mocked(ctx.ui.notify).mockClear();
    await handler?.('--all', ctx);
    const [allMessage] = vi.mocked(ctx.ui.notify).mock.calls[0] ?? [];
    expect(allMessage).toContain('rt-5  unknown  5s  dead  reason=pid_missing');
    expect(allMessage).toContain('  session warning');
    expect(allMessage).toContain('  diagnostics: activity_stale');
    expect(allMessage).toContain('Diagnostics:');
    expect(allMessage).toContain('malformed_activity_record');
  });

  it('shows session names by default and keeps session ids behind --identity', async () => {
    const { api, getHandler } = createMockAPI();

    registerSessionDeckCommand(api, {
      readSessionDeckSnapshot: vi.fn(async () =>
        buildSnapshot({
          records: [
            buildSnapshotRecord({
              sessionName: 'alpha',
              isLinkedWorktree: true,
              worktreeLabel: 'feature-sandbox',
            }),
          ],
        }),
      ),
    });

    const handler = getHandler();
    const ctx = createCommandContext({ mode: 'rpc' });

    await handler?.('', ctx);
    const [defaultMessage] = vi.mocked(ctx.ui.notify).mock.calls[0] ?? [];
    expect(defaultMessage).toContain('  alpha');
    expect(defaultMessage).not.toContain('session=session-');
    expect(defaultMessage).not.toContain('name=alpha');
    expect(defaultMessage).not.toContain('checkout: linked worktree');

    vi.mocked(ctx.ui.notify).mockClear();
    await handler?.('--identity', ctx);
    const [identityMessage] = vi.mocked(ctx.ui.notify).mock.calls[0] ?? [];
    expect(identityMessage).toContain('  alpha');
    expect(identityMessage).toContain('session=session-');
    expect(identityMessage).not.toContain('name=alpha');
    expect(identityMessage).not.toContain('checkout: linked worktree');
  });

  it('preserves reap output while reading the joined snapshot', async () => {
    const { api, getHandler } = createMockAPI();
    const reapPresence = vi.fn(async () => ({
      removed: ['/tmp/rt-expired.json'],
      diagnostics: [],
    }));
    const readSessionDeckSnapshot = vi.fn(async () => buildSnapshot({ records: [] }));

    registerSessionDeckCommand(api, {
      readSessionDeckSnapshot,
      reapPresenceRecords: reapPresence,
    });

    const handler = getHandler();
    const ctx = createCommandContext({ mode: 'rpc' });

    await handler?.('--reap', ctx);

    expect(reapPresence).toHaveBeenCalledTimes(1);
    expect(readSessionDeckSnapshot).toHaveBeenCalledTimes(1);
    const [message] = vi.mocked(ctx.ui.notify).mock.calls[0] ?? [];
    expect(message).toContain('Reap complete: removed 1 expired presence record.');
    expect(message).toContain('Removed:');
    expect(message).toContain('- rt-expired');
    expect(message).toContain('No live or stale Pi sessions found.');
  });

  it('dispatches to a custom browser in tui mode; manual and auto refresh never rerun reap', async () => {
    vi.useFakeTimers();

    const { api, getHandler } = createMockAPI();
    const reapPresence = vi.fn(async () => ({
      removed: ['/tmp/rt-expired.json'],
      diagnostics: [],
    }));
    const readSessionDeckSnapshot = vi
      .fn<() => Promise<SessionDeckSnapshot>>()
      .mockResolvedValueOnce(
        buildSnapshot({
          records: [
            buildSnapshotRecord({
              sessionName: 'alpha',
              chips: ['merge-ready clean', 'queue 2'],
            }),
            buildSnapshotRecord({
              runtimeId: 'rt-dead',
              pid: 202,
              sessionName: null,
              repoName: null,
              cwd: null,
              branch: null,
              prUrl: null,
              presenceState: 'dead',
              presenceReason: 'pid_missing',
              activityState: 'unknown',
            }),
          ],
        }),
      )
      .mockResolvedValueOnce(
        buildSnapshot({
          records: [buildSnapshotRecord({ sessionName: 'beta' })],
        }),
      )
      .mockResolvedValueOnce(
        buildSnapshot({
          records: [buildSnapshotRecord({ sessionName: 'gamma' })],
        }),
      );

    registerSessionDeckCommand(api, {
      readSessionDeckSnapshot,
      reapPresenceRecords: reapPresence,
    });

    const handler = getHandler();
    const requestRender = vi.fn();
    const custom = vi.fn(async (factory) => {
      const component = factory(
        { requestRender },
        createTheme() as never,
        undefined,
        () => undefined,
      );

      try {
        const initialRender = component.render(120).join('\n');
        expect(initialRender).toContain('Reap complete: removed 1 expired presence record.');
        expect(initialRender).toContain('Pi sessions · 1 live · 0 stale · 1 dead · 0 unknown');
        expect(initialRender).toContain('› ● waiting  alpha  project · #42 · 5s · main');
        expect(initialRender).toContain('  │ merge-ready clean · queue 2');
        expect(initialRender).toContain('  × unknown  rt-dead  5s');
        expect(initialRender).not.toContain('Selected session');
        expect(initialRender).toContain('cwd: ~/project');
        expect(initialRender).toContain('branch: main · pr: #42');
        expect(initialRender).toContain('presence: ● live · activity: waiting · heartbeat: 5s ago');
        expect(initialRender).toContain('chips: merge-ready clean · queue 2');
        expect(initialRender).toContain('runtime: 922f7ac8deadbeef · pid: 101');
        expect(initialRender).toContain('session: session-abc');
        expect(initialRender).not.toContain('repo: project');

        component.handleInput?.('r');

        await vi.waitFor(() => {
          expect(readSessionDeckSnapshot).toHaveBeenCalledTimes(2);
          expect(component.render(120).join('\n')).toContain(
            '› ● waiting  beta  project · #42 · 5s · main',
          );
        });

        await vi.advanceTimersByTimeAsync(15_000);

        expect(readSessionDeckSnapshot).toHaveBeenCalledTimes(3);
        expect(component.render(120).join('\n')).toContain(
          '› ● waiting  gamma  project · #42 · 5s · main',
        );
      } finally {
        component.dispose?.();
      }
    });
    const ctx = createCommandContext({
      mode: 'tui',
      ui: {
        notify: vi.fn(),
        custom: custom as NonNullable<PresenceCommandContext['ui']['custom']>,
      },
    });

    await handler?.('--all --identity --reap', ctx);

    expect(reapPresence).toHaveBeenCalledTimes(1);
    expect(custom).toHaveBeenCalledTimes(1);
    expect(vi.mocked(ctx.ui.notify)).not.toHaveBeenCalled();
    expect(requestRender).toHaveBeenCalled();
  });

  it('falls back to notify outside tui mode', async () => {
    const { api, getHandler } = createMockAPI();

    registerSessionDeckCommand(api, {
      readSessionDeckSnapshot: vi.fn(async () => buildSnapshot({ records: [] })),
    });

    const handler = getHandler();
    const custom = vi.fn();
    const ctx = createCommandContext({
      mode: 'rpc',
      ui: {
        notify: vi.fn(),
        custom: custom as NonNullable<PresenceCommandContext['ui']['custom']>,
      },
    });

    await handler?.('', ctx);

    expect(custom).not.toHaveBeenCalled();
    expect(vi.mocked(ctx.ui.notify)).toHaveBeenCalledWith(
      expect.stringContaining('No live or stale Pi sessions found.'),
      'info',
    );
  });

  it('registers the expected slash command name', () => {
    const { api } = createMockAPI();

    registerSessionDeckCommand(api, {
      readSessionDeckSnapshot: vi.fn(async () => buildSnapshot({ records: [] })),
    });

    expect(vi.mocked(api.registerCommand)).toHaveBeenCalledWith(
      SESSION_DECK_COMMAND_NAME,
      expect.objectContaining({
        description: expect.stringContaining('presence, identity, activity, and chips'),
      }),
    );
  });
});

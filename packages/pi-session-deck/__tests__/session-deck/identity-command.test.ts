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
  it('parses strict flag combinations, including paired json lookup mode', () => {
    expect(parseSessionDeckCommandArgs('')).toEqual({
      ok: true,
      all: false,
      reap: false,
      identity: false,
      json: false,
      sessionId: null,
    });
    expect(parseSessionDeckCommandArgs('--all')).toEqual({
      ok: true,
      all: true,
      reap: false,
      identity: false,
      json: false,
      sessionId: null,
    });
    expect(parseSessionDeckCommandArgs('--reap --identity')).toEqual({
      ok: true,
      all: false,
      reap: true,
      identity: true,
      json: false,
      sessionId: null,
    });
    expect(parseSessionDeckCommandArgs('--all --reap --identity')).toEqual({
      ok: true,
      all: true,
      reap: true,
      identity: true,
      json: false,
      sessionId: null,
    });
    expect(parseSessionDeckCommandArgs('--json --session-id session-abc')).toEqual({
      ok: true,
      all: false,
      reap: false,
      identity: false,
      json: true,
      sessionId: 'session-abc',
    });
    expect(parseSessionDeckCommandArgs('--session-id session-abc --json --all')).toEqual({
      ok: true,
      all: true,
      reap: false,
      identity: false,
      json: true,
      sessionId: 'session-abc',
    });
  });

  it('reports explicit parse errors for invalid flag shapes', () => {
    expect(parseSessionDeckCommandArgs('--identity --identity')).toEqual({
      ok: false,
      message: 'Duplicate flag: --identity',
    });
    expect(parseSessionDeckCommandArgs('--json --json --session-id session-abc')).toEqual({
      ok: false,
      message: 'Duplicate flag: --json',
    });
    expect(
      parseSessionDeckCommandArgs('--json --session-id session-abc --session-id other'),
    ).toEqual({
      ok: false,
      message: 'Duplicate flag: --session-id',
    });
    expect(parseSessionDeckCommandArgs('--session-id')).toEqual({
      ok: false,
      message: 'Missing value for --session-id',
    });
    expect(parseSessionDeckCommandArgs('--session-id --json')).toEqual({
      ok: false,
      message: 'Missing value for --session-id',
    });
    expect(parseSessionDeckCommandArgs('--json')).toEqual({
      ok: false,
      message: '--json requires --session-id <id>',
    });
    expect(parseSessionDeckCommandArgs('--session-id session-abc')).toEqual({
      ok: false,
      message: '--session-id requires --json',
    });
    expect(parseSessionDeckCommandArgs('--wat')).toEqual({
      ok: false,
      message: 'Unsupported argument: --wat',
    });
  });

  it('offers --all, --reap, --identity, --json, and --session-id completions', () => {
    const { api, getRegistration } = createMockAPI();

    registerSessionDeckCommand(api, {
      readSessionDeckSnapshot: vi.fn(async () => buildSnapshot({ records: [] })),
    });

    expect(getRegistration()?.getArgumentCompletions?.('')).toEqual([
      { value: '--all', label: '--all' },
      { value: '--reap', label: '--reap' },
      { value: '--identity', label: '--identity' },
      { value: '--json', label: '--json' },
      { value: '--session-id', label: '--session-id' },
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
    expect(defaultMessage).toContain('922f7ac8  idle  5s');
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
    expect(defaultMessage).not.toContain('repo:');

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
    expect(defaultMessage).not.toContain('checkout: worktree');

    vi.mocked(ctx.ui.notify).mockClear();
    await handler?.('--identity', ctx);
    const [identityMessage] = vi.mocked(ctx.ui.notify).mock.calls[0] ?? [];
    expect(identityMessage).toContain('  alpha');
    expect(identityMessage).toContain('session=session-');
    expect(identityMessage).not.toContain('name=alpha');
    expect(identityMessage).not.toContain('checkout: worktree');
  });

  it('emits one pretty-printed public record in json mode and keeps --identity presentation-only', async () => {
    const { api, getHandler } = createMockAPI();
    const publicRecord = buildSnapshotRecord({
      sessionName: 'alpha',
      derivedFacets: {
        persistence: 'file_backed',
        interactivity: 'interactive',
        lifecycle: 'resume',
        lineage: 'root',
        identityStrength: 'strong',
        headerConsistency: 'consistent',
      },
    });
    const expectedJsonRecord: SessionDeckRecord = {
      runtimeId: publicRecord.runtimeId,
      pid: publicRecord.pid,
      presenceState: publicRecord.presenceState,
      ...(publicRecord.presenceReason === undefined
        ? {}
        : { presenceReason: publicRecord.presenceReason }),
      heartbeatAgeMs: publicRecord.heartbeatAgeMs,
      sessionId: publicRecord.sessionId,
      sessionName: publicRecord.sessionName,
      repoName: publicRecord.repoName,
      qualifiedRepoName: publicRecord.qualifiedRepoName,
      cwd: publicRecord.cwd,
      branch: publicRecord.branch,
      prUrl: publicRecord.prUrl,
      isLinkedWorktree: publicRecord.isLinkedWorktree,
      worktreeLabel: publicRecord.worktreeLabel,
      ...(publicRecord.derivedFacets === undefined
        ? {}
        : { derivedFacets: publicRecord.derivedFacets }),
      activityState: publicRecord.activityState,
      activityAgeMs: publicRecord.activityAgeMs,
      currentToolName: publicRecord.currentToolName,
      lastError: publicRecord.lastError,
      chips: publicRecord.chips,
      diagnostics: publicRecord.diagnostics,
    };
    const leakyRecord = {
      ...publicRecord,
      sessionFile: '/tmp/private-session.json',
      worktree: `${HOME}/project`,
    } as SessionDeckRecord;

    registerSessionDeckCommand(api, {
      readSessionDeckSnapshot: vi.fn(async () => buildSnapshot({ records: [leakyRecord] })),
    });

    const handler = getHandler();
    const ctx = createCommandContext({ mode: 'rpc' });

    await handler?.('--json --session-id session-abc', ctx);

    const [jsonMessage, jsonLevel] = vi.mocked(ctx.ui.notify).mock.calls[0] ?? [];
    expect(jsonLevel).toBe('info');
    expect(jsonMessage).toBe(JSON.stringify(expectedJsonRecord, null, 2));
    expect(jsonMessage).not.toContain('sessionFile');
    expect(jsonMessage).not.toContain('"worktree"');

    vi.mocked(ctx.ui.notify).mockClear();
    await handler?.('--json --session-id session-abc --identity', ctx);
    const [identityJsonMessage, identityJsonLevel] = vi.mocked(ctx.ui.notify).mock.calls[0] ?? [];
    expect(identityJsonLevel).toBe('info');
    expect(identityJsonMessage).toBe(JSON.stringify(expectedJsonRecord, null, 2));
  });

  it('preserves visible-row semantics for json lookups and widens eligibility with --all', async () => {
    const { api, getHandler } = createMockAPI();
    const deadRecord = buildSnapshotRecord({
      runtimeId: 'rt-dead',
      sessionId: 'session-dead',
      presenceState: 'dead',
      presenceReason: 'pid_missing',
      activityState: 'unknown',
    });

    registerSessionDeckCommand(api, {
      readSessionDeckSnapshot: vi.fn(async () => buildSnapshot({ records: [deadRecord] })),
    });

    const handler = getHandler();
    const ctx = createCommandContext({ mode: 'rpc' });

    await handler?.('--json --session-id session-dead', ctx);
    expect(vi.mocked(ctx.ui.notify)).toHaveBeenCalledWith(
      'No matching session found for session id "session-dead".',
      'error',
    );

    vi.mocked(ctx.ui.notify).mockClear();
    await handler?.('--all --json --session-id session-dead', ctx);
    expect(vi.mocked(ctx.ui.notify)).toHaveBeenCalledWith(
      JSON.stringify(deadRecord, null, 2),
      'info',
    );
  });

  it('reports ambiguous json lookup errors instead of guessing', async () => {
    const { api, getHandler } = createMockAPI();

    registerSessionDeckCommand(api, {
      readSessionDeckSnapshot: vi.fn(async () =>
        buildSnapshot({
          records: [
            buildSnapshotRecord({ runtimeId: 'rt-1', sessionId: 'session-dup' }),
            buildSnapshotRecord({ runtimeId: 'rt-2', sessionId: 'session-dup' }),
          ],
        }),
      ),
    });

    const handler = getHandler();
    const ctx = createCommandContext({ mode: 'rpc' });

    await handler?.('--json --session-id session-dup', ctx);

    expect(vi.mocked(ctx.ui.notify)).toHaveBeenCalledWith(
      'Ambiguous session id "session-dup": matched 2 sessions.',
      'error',
    );
  });

  it('bypasses the tui browser for json lookups', async () => {
    const { api, getHandler } = createMockAPI();

    registerSessionDeckCommand(api, {
      readSessionDeckSnapshot: vi.fn(async () => buildSnapshot()),
    });

    const handler = getHandler();
    const custom = vi.fn();
    const ctx = createCommandContext({
      mode: 'tui',
      ui: {
        notify: vi.fn(),
        custom: custom as NonNullable<PresenceCommandContext['ui']['custom']>,
      },
    });

    await handler?.('--json --session-id session-abc', ctx);

    expect(custom).not.toHaveBeenCalled();
    expect(vi.mocked(ctx.ui.notify)).toHaveBeenCalledWith(
      JSON.stringify(buildSnapshotRecord(), null, 2),
      'info',
    );
  });

  it('reaps before json lookup and returns json only', async () => {
    const { api, getHandler } = createMockAPI();
    const callOrder: string[] = [];
    const reapPresence = vi.fn(async () => {
      callOrder.push('reap');
      return {
        removed: ['/tmp/rt-expired.json'],
        diagnostics: [],
      };
    });
    const readSessionDeckSnapshot = vi.fn(async () => {
      callOrder.push('read');
      return buildSnapshot();
    });

    registerSessionDeckCommand(api, {
      readSessionDeckSnapshot,
      reapPresenceRecords: reapPresence,
    });

    const handler = getHandler();
    const ctx = createCommandContext({ mode: 'rpc' });

    await handler?.('--reap --json --session-id session-abc', ctx);

    expect(reapPresence).toHaveBeenCalledTimes(1);
    expect(readSessionDeckSnapshot).toHaveBeenCalledTimes(1);
    expect(callOrder).toEqual(['reap', 'read']);
    const [message, level] = vi.mocked(ctx.ui.notify).mock.calls[0] ?? [];
    expect(level).toBe('info');
    expect(message).toBe(JSON.stringify(buildSnapshotRecord(), null, 2));
    expect(message).not.toContain('Reap complete');
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

  it('dispatches to a custom browser in tui mode, shows session ids by default, and keeps refresh/reap wiring stable', async () => {
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
              qualifiedRepoName: null,
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
        const renderText = () => component.render(120).join('\n');

        expect(renderText()).toContain('Reap complete: removed 1 expired presence record.');
        expect(renderText()).toContain('←→ switch repo');
        expect(renderText()).toContain('alpha');
        expect(renderText()).toContain('session: session-abc · pid: 101');
        expect(renderText()).toContain('runtime: 922f7ac8deadbeef');
        expect(renderText()).not.toContain('runtime: 922f7ac8deadbeef · pid: 101');
        expect(renderText()).toContain('rt-dead');

        component.handleInput?.('r');

        await vi.waitFor(() => {
          expect(readSessionDeckSnapshot).toHaveBeenCalledTimes(2);
          expect(renderText()).toContain('beta');
        });

        await vi.advanceTimersByTimeAsync(15_000);

        expect(readSessionDeckSnapshot).toHaveBeenCalledTimes(3);
        expect(renderText()).toContain('gamma');
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

    await handler?.('--all --reap', ctx);

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

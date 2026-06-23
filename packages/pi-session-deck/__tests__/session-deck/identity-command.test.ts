import { describe, expect, it, vi } from 'vitest';
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

function createCommandContext(): PresenceCommandContext {
  return {
    ui: {
      notify: vi.fn(),
    },
  };
}

function buildSnapshotRecord(overrides: Partial<SessionDeckRecord> = {}): SessionDeckRecord {
  return {
    runtimeId: 'rt-1',
    presenceState: 'live',
    presenceReason: 'fresh_heartbeat',
    heartbeatAgeMs: 5_000,
    sessionId: 'session-abc',
    sessionName: 'alpha',
    cwd: '/home/user/project',
    branch: 'main',
    prUrl: 'https://github.com/owner/repo/pull/42',
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

  it('renders compact activity summaries, inline chips, and all-mode diagnostics', async () => {
    const { api, getHandler } = createMockAPI();
    const readSessionDeckSnapshot = vi.fn(async () =>
      buildSnapshot({
        records: [
          buildSnapshotRecord({ chips: ['merge-ready clean'] }),
          buildSnapshotRecord({
            runtimeId: 'rt-2',
            presenceState: 'stale',
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
            runtimeId: 'rt-5',
            presenceState: 'dead',
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
    const ctx = createCommandContext();

    await handler?.('', ctx);
    const [defaultMessage] = vi.mocked(ctx.ui.notify).mock.calls[0] ?? [];
    expect(defaultMessage).toContain('activity=waiting');
    expect(defaultMessage).toContain('chips=[merge-ready clean]');
    expect(defaultMessage).toContain('activity=thinking 3m');
    expect(defaultMessage).toContain('activity=tool-running: read 42s');
    expect(defaultMessage).toContain('chips=[status syncing | queue 2]');
    expect(defaultMessage).toContain('activity=error: tool bash failed');
    expect(defaultMessage).not.toContain('rt-5');
    expect(defaultMessage).toContain('presence=live');
    expect(defaultMessage).not.toContain('scope=');
    expect(defaultMessage).not.toContain('updatedAt=');

    vi.mocked(ctx.ui.notify).mockClear();
    await handler?.('--all', ctx);
    const [allMessage] = vi.mocked(ctx.ui.notify).mock.calls[0] ?? [];
    expect(allMessage).toContain('rt-5');
    expect(allMessage).toContain('chips=[session warning]');
    expect(allMessage).toContain('activity=unknown [activity_stale]');
    expect(allMessage).toContain('Diagnostics:');
    expect(allMessage).toContain('malformed_activity_record');
  });

  it('shows identity extras only with --identity', async () => {
    const { api, getHandler } = createMockAPI();

    registerSessionDeckCommand(api, {
      readSessionDeckSnapshot: vi.fn(async () => buildSnapshot()),
    });

    const handler = getHandler();
    const ctx = createCommandContext();

    await handler?.('', ctx);
    const [defaultMessage] = vi.mocked(ctx.ui.notify).mock.calls[0] ?? [];
    expect(defaultMessage).not.toContain('session=session-');
    expect(defaultMessage).not.toContain('name=alpha');

    vi.mocked(ctx.ui.notify).mockClear();
    await handler?.('--identity', ctx);
    const [identityMessage] = vi.mocked(ctx.ui.notify).mock.calls[0] ?? [];
    expect(identityMessage).toContain('session=session-');
    expect(identityMessage).toContain('name=alpha');
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
    const ctx = createCommandContext();

    await handler?.('--reap', ctx);

    expect(reapPresence).toHaveBeenCalledTimes(1);
    expect(readSessionDeckSnapshot).toHaveBeenCalledTimes(1);
    const [message] = vi.mocked(ctx.ui.notify).mock.calls[0] ?? [];
    expect(message).toContain('Reap complete: removed 1 expired presence record.');
    expect(message).toContain('Removed:');
    expect(message).toContain('- rt-expired');
    expect(message).toContain('No live or stale Pi sessions found.');
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

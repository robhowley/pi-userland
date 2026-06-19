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
import type { PresenceView } from '../../extensions/session-deck/presence/types.js';
import type { JoinedSessionView } from '../../extensions/session-deck/identity/types.js';
import type { SessionDeckView } from '../../extensions/session-deck/activity/types.js';

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

function buildPresenceView(): PresenceView {
  return {
    records: [
      {
        runtimeId: 'rt-1',
        pid: 101,
        startedAt: '2026-06-17T11:00:00.000Z',
        heartbeatAt: '2026-06-17T12:09:55.000Z',
        heartbeatAgeMs: 5_000,
        presenceState: 'live',
        reason: 'fresh_heartbeat',
      },
    ],
    diagnostics: [],
  };
}

function buildJoinedView(): JoinedSessionView {
  return {
    records: [
      {
        runtimeId: 'rt-1',
        pid: 101,
        presenceState: 'live',
        heartbeatAt: '2026-06-17T12:09:55.000Z',
        heartbeatAgeMs: 5_000,
        startedAt: '2026-06-17T11:00:00.000Z',
        presenceReason: 'fresh_heartbeat',
        sessionId: 'session-abc',
        sessionFile: '/tmp/session-abc.json',
        sessionName: null,
        cwd: '/home/user/project',
        worktree: '/home/user/project',
        branch: 'main',
        prUrl: 'https://github.com/owner/repo/pull/42',
        identityUpdatedAt: '2026-06-17T12:09:00.000Z',
        identityFreshness: 'fresh',
        diagnostics: [],
      },
    ],
    diagnostics: [],
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
      readPresenceView: vi.fn(async () => buildPresenceView()),
      readJoinedSessionView: vi.fn(async () => buildJoinedView()),
      readSessionDeckView: vi.fn(async () => ({ records: [], diagnostics: [] })),
    });

    expect(getRegistration()?.getArgumentCompletions?.('')).toEqual([
      { value: '--all', label: '--all' },
      { value: '--reap', label: '--reap' },
      { value: '--identity', label: '--identity' },
    ]);
  });

  it('renders compact activity summaries and all-mode diagnostics', async () => {
    const { api, getHandler } = createMockAPI();
    const readPresenceView = vi.fn(async () => buildPresenceView());
    const readJoinedSessionView = vi.fn(async () => buildJoinedView());
    const readSessionDeckView = vi.fn(
      async (): Promise<SessionDeckView> => ({
        records: [
          {
            ...buildJoinedView().records[0]!,
            activityState: 'waiting',
            activityAgeMs: null,
            idle: true,
            busy: false,
            currentTurnStartedAt: null,
            currentToolName: null,
            lastEventAt: '2026-06-17T12:09:55.000Z',
            lastError: null,
            activityUpdatedAt: '2026-06-17T12:09:55.000Z',
            diagnostics: [],
          },
          {
            ...buildJoinedView().records[0]!,
            runtimeId: 'rt-2',
            activityState: 'thinking',
            activityAgeMs: 180_000,
            idle: false,
            busy: true,
            currentTurnStartedAt: '2026-06-17T12:07:00.000Z',
            currentToolName: null,
            lastEventAt: '2026-06-17T12:09:55.000Z',
            lastError: null,
            activityUpdatedAt: '2026-06-17T12:09:55.000Z',
            diagnostics: [],
          },
          {
            ...buildJoinedView().records[0]!,
            runtimeId: 'rt-3',
            activityState: 'tool-running',
            activityAgeMs: 42_000,
            idle: false,
            busy: true,
            currentTurnStartedAt: '2026-06-17T12:07:00.000Z',
            currentToolName: 'read',
            lastEventAt: '2026-06-17T12:09:18.000Z',
            lastError: null,
            activityUpdatedAt: '2026-06-17T12:09:18.000Z',
            diagnostics: [],
          },
          {
            ...buildJoinedView().records[0]!,
            runtimeId: 'rt-4',
            activityState: 'error',
            activityAgeMs: null,
            idle: false,
            busy: false,
            currentTurnStartedAt: null,
            currentToolName: null,
            lastEventAt: '2026-06-17T12:09:30.000Z',
            lastError: 'tool bash failed',
            activityUpdatedAt: '2026-06-17T12:09:30.000Z',
            diagnostics: [{ code: 'last_error_active', message: 'Assistant error is active' }],
          },
          {
            ...buildJoinedView().records[0]!,
            runtimeId: 'rt-5',
            presenceState: 'dead',
            activityState: 'unknown',
            activityAgeMs: null,
            idle: null,
            busy: null,
            currentTurnStartedAt: null,
            currentToolName: null,
            lastEventAt: null,
            lastError: null,
            activityUpdatedAt: null,
            diagnostics: [{ code: 'activity_stale', message: 'Activity record is stale' }],
          },
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
      readPresenceView,
      readJoinedSessionView,
      readSessionDeckView,
    });

    const handler = getHandler();
    const ctx = createCommandContext();

    await handler?.('', ctx);
    const [defaultMessage] = vi.mocked(ctx.ui.notify).mock.calls[0] ?? [];
    expect(defaultMessage).toContain('activity=waiting');
    expect(defaultMessage).toContain('activity=thinking 3m');
    expect(defaultMessage).toContain('activity=tool-running: read 42s');
    expect(defaultMessage).toContain('activity=error: tool bash failed');
    expect(defaultMessage).not.toContain('rt-5');
    expect(defaultMessage).toContain('presence=live');

    vi.mocked(ctx.ui.notify).mockClear();
    await handler?.('--all', ctx);
    const [allMessage] = vi.mocked(ctx.ui.notify).mock.calls[0] ?? [];
    expect(allMessage).toContain('rt-5');
    expect(allMessage).toContain('activity=unknown [activity_stale]');
    expect(allMessage).toContain('Diagnostics:');
    expect(allMessage).toContain('malformed_activity_record');
  });

  it('registers the expected slash command name', () => {
    const { api } = createMockAPI();

    registerSessionDeckCommand(api, {
      readPresenceView: vi.fn(async () => buildPresenceView()),
      readJoinedSessionView: vi.fn(async () => buildJoinedView()),
      readSessionDeckView: vi.fn(async () => ({ records: [], diagnostics: [] })),
    });

    expect(vi.mocked(api.registerCommand)).toHaveBeenCalledWith(
      SESSION_DECK_COMMAND_NAME,
      expect.objectContaining({
        description: expect.stringContaining('presence, identity, and activity'),
      }),
    );
  });
});

// @ts-nocheck
import { beforeEach, describe, expect, it, vi } from 'vitest';
import sessionHygieneExtension from '../src/index.js';
import {
  CONFIG_DIR,
  CONFIG_FILE,
  PRESETS,
  computeHealth,
  formatCacheRate,
  isValidThresholds,
  loadConfig,
  reconstructCost,
  saveConfig,
  updateStatusIndicator,
} from '../src/helpers.js';
import type { AssistantMessage } from '@mariozechner/pi-ai';
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from '@mariozechner/pi-coding-agent';
import * as fs from 'node:fs';

vi.mock('node:fs');

const DEFAULT_THRESHOLDS = PRESETS["Default"];

function makeBranch(...costs: number[]) {
  return costs.map((cost) => ({
    type: 'message' as const,
    message: {
      role: 'assistant' as const,
      usage: { cost: { total: cost } },
    } as AssistantMessage,
  }));
}

function turnEndEvent(cost?: number, cacheStats?: { input: number; cacheRead: number }) {
  return {
    message: {
      role: 'assistant' as const,
      usage: {
        ...(typeof cost === 'number' ? { cost: { total: cost } } : {}),
        ...cacheStats,
      },
    },
  };
}

function createCtx(
  opts: { contextTokens?: number | null; hasUI?: boolean } = {},
): ExtensionContext & ExtensionCommandContext {
  const tokens = opts.contextTokens ?? null;

  return {
    cwd: '/test/cwd',
    hasUI: opts.hasUI ?? true,
    getContextUsage: vi.fn(() => (tokens !== null ? { tokens } : null)),
    ui: {
      notify: vi.fn(),
      setStatus: vi.fn(),
      confirm: vi.fn(),
      select: vi.fn(),
      input: vi.fn(),
      theme: {
        bold: (s: string) => s,
        fg: (_color: string, s: string) => s,
      },
    },
    sessionManager: {
      getBranch: vi.fn(() => []),
      getSessionFile: vi.fn(() => '/test/session.jsonl'),
    },
    compact: vi.fn(),
    newSession: vi.fn(),
  } as any;
}

function createMockAPI(): ExtensionAPI {
  const eventHandlers = new Map<string, Function[]>();

  return {
    registerTool: vi.fn(),
    registerCommand: vi.fn(),
    sendUserMessage: vi.fn(),
    on: vi.fn((event, handler) => {
      if (!eventHandlers.has(event)) eventHandlers.set(event, []);
      eventHandlers.get(event)!.push(handler);
    }),
    _eventHandlers: eventHandlers,
  } as any;
}

function setupExtension(api?: ReturnType<typeof createMockAPI>) {
  const _api = api ?? createMockAPI();
  sessionHygieneExtension(_api);

  const handlers = (_api as any)._eventHandlers as Map<string, Function[]>;
  const sessionStart = (ctx: any) => handlers.get('session_start')![0]({}, ctx);
  const turnEnd = (event: any, ctx: any) => handlers.get('turn_end')![0](event, ctx);
  const sessionCompact = (event: any, ctx: any) => handlers.get('session_compact')![0](event, ctx);
  const getCommand = (name: string) =>
    vi.mocked(_api.registerCommand).mock.calls.find((call) => call[0] === name)?.[1].handler;

  return { api: _api, handlers, sessionStart, turnEnd, sessionCompact, getCommand };
}

async function setupWithSession(
  opts: { contextTokens?: number | null; branchCosts?: number[] } = {},
) {
  const ext = setupExtension();
  const ctx = createCtx({ contextTokens: opts.contextTokens ?? 10_000 });

  if (opts.branchCosts) {
    vi.mocked(ctx.sessionManager.getBranch).mockReturnValue(makeBranch(...opts.branchCosts) as any);
  }

  await ext.sessionStart(ctx);

  return { ...ext, ctx };
}

describe('session-hygiene', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fs.existsSync).mockReturnValue(false);
    vi.mocked(fs.readFileSync).mockReturnValue('');
    vi.mocked(fs.mkdirSync).mockImplementation(() => undefined);
    vi.mocked(fs.writeFileSync).mockImplementation(() => undefined);
  });

  describe('registration', () => {
    it('registers the status bar handlers and only the /session-hygiene command', () => {
      const { handlers, getCommand } = setupExtension();

      expect(handlers.has('session_start')).toBe(true);
      expect(handlers.has('turn_end')).toBe(true);
      expect(handlers.has('session_compact')).toBe(true);
      expect(handlers.has('before_agent_start')).toBe(false);
      expect(handlers.has('session_before_compact')).toBe(false);

      expect(getCommand('session-hygiene')).toBeTypeOf('function');
      expect(getCommand('session-hygiene:compact')).toBeUndefined();
      expect(getCommand('session-hygiene:template')).toBeUndefined();
    });
  });

  describe('helper functions', () => {
    // 
    it.each([
      ['green when under all thresholds', 3, 50_000, 'green'],
      ['yellow when cost exceeds yellow threshold', 6, 50_000, 'yellow'],
      ['yellow when context exceeds yellow threshold', 3, 100_000, 'yellow'],
      ['red when cost exceeds red threshold', 16, 50_000, 'red'],
      ['red when context exceeds red threshold', 3, 210_000, 'red'],
      ['green when context is null and cost is under threshold', 3, null, 'green'],
      ['red when cost is red even if context is null', 16, null, 'red'],
    ] as [string, number, number | null, string][])((_, cost, ctx, expected) => {
      // 
      expect(computeHealth(cost, ctx, DEFAULT_THRESHOLDS)).toBe(expected);
    });

    it('formats cache hit rate', () => {
      expect(formatCacheRate(0, 0)).toBeNull();
      expect(formatCacheRate(100, 0)).toBe('0% cache');
      expect(formatCacheRate(200, 800)).toBe('80% cache');
    });

    it('updates the status indicator for all health levels', () => {
      const ctx = createCtx();

      updateStatusIndicator('green', ctx, { inputTokens: 0, cacheReadTokens: 0 });
      updateStatusIndicator('yellow', ctx, { inputTokens: 200, cacheReadTokens: 800 });
      updateStatusIndicator('red', ctx, { inputTokens: 100, cacheReadTokens: 0 });

      expect(vi.mocked(ctx.ui.setStatus).mock.calls).toEqual([
        ['session-hygiene', '🟢 session healthy'],
        ['session-hygiene', '🟡 session growing · 80% cache'],
        ['session-hygiene', '🔴 session critical · 0% cache'],
      ]);
    });

    it('validates threshold objects', () => {
      expect(isValidThresholds(DEFAULT_THRESHOLDS)).toBe(true);
      expect(
        isValidThresholds({
          yellow: { cost: -1, context: 60_000 },
          red: { cost: 8, context: 120_000 },
        }),
      ).toBe(false);
      expect(
        isValidThresholds({
          yellow: { cost: 2, context: 120_000 },
          red: { cost: 8, context: 120_000 },
        }),
      ).toBe(false);
      expect(
        isValidThresholds({
          yellow: { cost: 8, context: 60_000 },
          red: { cost: 8, context: 120_000 },
        }),
      ).toBe(false);
      expect(isValidThresholds({ yellow: { cost: 2 }, red: { cost: 8, context: 120_000 } })).toBe(
        false,
      );
      expect(isValidThresholds(null)).toBe(false);
    });

    it('loads defaults when config is missing, invalid, or unreadable', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      expect(loadConfig()).toEqual(DEFAULT_THRESHOLDS);

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({
          yellow: { cost: 8, context: 60_000 },
          red: { cost: 8, context: 120_000 },
        }),
      );
      expect(loadConfig()).toEqual(DEFAULT_THRESHOLDS);

      vi.mocked(fs.readFileSync).mockImplementation(() => {
        throw new Error('disk error');
      });
      expect(loadConfig()).toEqual(DEFAULT_THRESHOLDS);
    });

    it('loads valid config from disk', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({
          yellow: { cost: 10, context: 100_000 },
          red: { cost: 20, context: 200_000 },
        }),
      );

      expect(loadConfig()).toEqual({
        yellow: { cost: 10, context: 100_000 },
        red: { cost: 20, context: 200_000 },
      });
    });

    it('saves config to the expected path', () => {
      expect(saveConfig(DEFAULT_THRESHOLDS)).toBe(true);
      expect(fs.mkdirSync).toHaveBeenCalledWith(CONFIG_DIR, { recursive: true });
      expect(fs.writeFileSync).toHaveBeenCalledWith(
        CONFIG_FILE,
        JSON.stringify(DEFAULT_THRESHOLDS, null, 2),
        { mode: 0o600 },
      );
    });

    it('returns false when saving config fails', () => {
      vi.mocked(fs.writeFileSync).mockImplementation(() => {
        throw new Error('write failed');
      });

      expect(saveConfig(DEFAULT_THRESHOLDS)).toBe(false);
    });

    it('reconstructs assistant cost from the session branch', () => {
      const ctx = createCtx();
      vi.mocked(ctx.sessionManager.getBranch).mockReturnValue([
        { type: 'other' },
        { type: 'message', message: { role: 'assistant', usage: { cost: { total: 1.5 } } } },
        { type: 'message', message: { role: 'user', content: 'hello' } },
        { type: 'message', message: undefined },
        { type: 'message', message: { role: 'assistant', usage: null } },
        { type: 'message', message: { role: 'assistant', usage: { cost: { total: 2.3 } } } },
      ] as any);

      expect(reconstructCost(ctx as any)).toBe(3.8);
    });
  });

  describe('session_start', () => {
    it('initializes status from reconstructed branch cost', async () => {
      const { sessionStart } = setupExtension();
      const ctx = createCtx({ contextTokens: 10_000 });
      vi.mocked(ctx.sessionManager.getBranch).mockReturnValue(makeBranch(6.0) as any);

      await sessionStart(ctx);

      expect(ctx.ui.setStatus).toHaveBeenCalledWith('session-hygiene', '🟡 session growing');
    });

    it('handles missing context usage', async () => {
      const { sessionStart } = setupExtension();
      const ctx = createCtx({ contextTokens: null });
      vi.mocked(ctx.getContextUsage).mockReturnValue(null as any);

      await sessionStart(ctx);

      expect(ctx.ui.setStatus).toHaveBeenCalledWith('session-hygiene', '🟢 session healthy');
    });
  });

  describe('turn_end', () => {
    it('updates status from cost and cache stats without prompting for compact', async () => {
      const { turnEnd, ctx } = await setupWithSession({ contextTokens: 10_000 });

      await turnEnd(turnEndEvent(6.0, { input: 200, cacheRead: 800 }), ctx);

      expect(vi.mocked(ctx.ui.setStatus).mock.calls.at(-1)).toEqual([
        'session-hygiene',
        '🟡 session growing · 80% cache',
      ]);
      expect(ctx.ui.confirm).not.toHaveBeenCalled();
      expect(ctx.compact).not.toHaveBeenCalled();
    });

    it('accumulates cache stats across turns', async () => {
      const { turnEnd, ctx } = await setupWithSession({ contextTokens: 10_000 });

      await turnEnd(turnEndEvent(0.1, { input: 100, cacheRead: 0 }), ctx);
      await turnEnd(turnEndEvent(0.1, { input: 0, cacheRead: 900 }), ctx);

      expect(vi.mocked(ctx.ui.setStatus).mock.calls.at(-1)).toEqual([
        'session-hygiene',
        '🟢 session healthy · 90% cache',
      ]);
    });

    it('handles missing usage data and undefined context usage', async () => {
      const { turnEnd, ctx } = await setupWithSession({ contextTokens: 10_000 });
      vi.mocked(ctx.getContextUsage).mockReturnValue(undefined as any);

      await turnEnd({ message: { role: 'assistant' } }, ctx);
      await turnEnd({ message: null }, ctx);
      await turnEnd({ message: undefined }, ctx);

      expect(vi.mocked(ctx.ui.setStatus).mock.calls.at(-1)).toEqual([
        'session-hygiene',
        '🟢 session healthy',
      ]);
      expect(ctx.ui.confirm).not.toHaveBeenCalled();
    });
  });

  describe('/session-hygiene command', () => {
    it('shows current thresholds and allows cancellation', async () => {
      const { getCommand } = setupExtension();
      const ctx = createCtx();
      vi.mocked(ctx.ui.select).mockResolvedValue(null);

      await getCommand('session-hygiene')!([], ctx);

      expect(ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining('Current Thresholds'),
        'info',
      );
      expect(ctx.ui.notify).toHaveBeenCalledWith('Configuration cancelled', 'info');
    });

    it('saves a preset and refreshes status', async () => {
      const { sessionStart, getCommand } = setupExtension();
      const ctx = createCtx({ contextTokens: 100_000 });
      vi.mocked(ctx.ui.select).mockResolvedValue('Relaxed ($10/150K, $25/250K)');

      await sessionStart(ctx);
      await getCommand('session-hygiene')!([], ctx);

      expect(fs.writeFileSync).toHaveBeenCalledWith(
        CONFIG_FILE,
        expect.stringContaining('"cost": 10'),
        { mode: 0o600 },
      );
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining('Configuration saved'),
        'info',
      );
      expect(vi.mocked(ctx.ui.setStatus).mock.calls.at(-1)).toEqual([
        'session-hygiene',
        '🟢 session healthy',
      ]);
    });

    it('saves valid custom thresholds', async () => {
      const { getCommand } = setupExtension();
      const ctx = createCtx();
      vi.mocked(ctx.ui.select).mockResolvedValue('Custom (enter values manually)');
      vi.mocked(ctx.ui.input)
        .mockResolvedValueOnce('3')
        .mockResolvedValueOnce('60000')
        .mockResolvedValueOnce('10')
        .mockResolvedValueOnce('120000');

      await getCommand('session-hygiene')!([], ctx);

      expect(fs.writeFileSync).toHaveBeenCalledWith(
        CONFIG_FILE,
        expect.stringContaining('"cost": 3'),
        { mode: 0o600 },
      );
    });

    it('rejects custom thresholds with invalid numbers', async () => {
      const { getCommand } = setupExtension();
      const ctx = createCtx();
      vi.mocked(ctx.ui.select).mockResolvedValue('Custom (enter values manually)');
      vi.mocked(ctx.ui.input)
        .mockResolvedValueOnce('abc')
        .mockResolvedValueOnce('60000')
        .mockResolvedValueOnce('10')
        .mockResolvedValueOnce('120000');

      await getCommand('session-hygiene')!([], ctx);

      expect(ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining('Invalid thresholds'),
        'error',
      );
      expect(fs.writeFileSync).not.toHaveBeenCalled();
    });

    it('rejects custom thresholds when yellow cost is not below red cost', async () => {
      const { getCommand } = setupExtension();
      const ctx = createCtx();
      vi.mocked(ctx.ui.select).mockResolvedValue('Custom (enter values manually)');
      vi.mocked(ctx.ui.input)
        .mockResolvedValueOnce('10')
        .mockResolvedValueOnce('60000')
        .mockResolvedValueOnce('5')
        .mockResolvedValueOnce('120000');

      await getCommand('session-hygiene')!([], ctx);

      expect(ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining('Invalid thresholds'),
        'error',
      );
    });

    it('rejects custom thresholds when yellow context is not below red context', async () => {
      const { getCommand } = setupExtension();
      const ctx = createCtx();
      vi.mocked(ctx.ui.select).mockResolvedValue('Custom (enter values manually)');
      vi.mocked(ctx.ui.input)
        .mockResolvedValueOnce('5')
        .mockResolvedValueOnce('120000')
        .mockResolvedValueOnce('10')
        .mockResolvedValueOnce('60000');

      await getCommand('session-hygiene')!([], ctx);

      expect(ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining('Invalid thresholds'),
        'error',
      );
    });

    it('cancels when custom input is missing', async () => {
      const { getCommand } = setupExtension();
      const ctx = createCtx();
      vi.mocked(ctx.ui.select).mockResolvedValue('Custom (enter values manually)');
      vi.mocked(ctx.ui.input).mockResolvedValueOnce(null);

      await getCommand('session-hygiene')!([], ctx);

      expect(ctx.ui.notify).toHaveBeenCalledWith('Configuration cancelled', 'info');
    });

    it('keeps the session update even if saving config fails', async () => {
      const { sessionStart, getCommand } = setupExtension();
      const ctx = createCtx({ contextTokens: 100_000 });
      vi.mocked(ctx.ui.select).mockResolvedValue('Conservative ($2/60K, $8/120K)');
      vi.mocked(fs.writeFileSync).mockImplementation(() => {
        throw new Error('disk write failed');
      });

      await sessionStart(ctx);
      await getCommand('session-hygiene')!([], ctx);

      expect(ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining('Applied in this session but could not save to disk'),
        'warning',
      );
      expect(vi.mocked(ctx.ui.setStatus).mock.calls.at(-1)).toEqual([
        'session-hygiene',
        '🟡 session growing',
      ]);
    });
  });

  describe('session_compact', () => {
    it('resets running totals and cache stats after compaction', async () => {
      const ext = setupExtension();
      const ctx = createCtx({ contextTokens: 10_000 });

      await ext.sessionStart(ctx);
      await ext.turnEnd(turnEndEvent(0.5, { input: 200, cacheRead: 800 }), ctx);
      expect(vi.mocked(ctx.ui.setStatus).mock.calls.at(-1)?.[1]).toBe(
        '🟢 session healthy · 80% cache',
      );

      await ext.sessionCompact({}, ctx);

      expect(vi.mocked(ctx.ui.setStatus).mock.calls.at(-1)).toEqual([
        'session-hygiene',
        '🟢 session healthy',
      ]);
      expect(ctx.ui.confirm).not.toHaveBeenCalled();
    });

    it('recomputes health from current context after compaction', async () => {
      const { sessionCompact } = setupExtension();
      const ctx = createCtx({ contextTokens: 210_000 });

      await sessionCompact({}, ctx);

      expect(ctx.ui.setStatus).toHaveBeenCalledWith('session-hygiene', '🔴 session critical');
    });
  });
});

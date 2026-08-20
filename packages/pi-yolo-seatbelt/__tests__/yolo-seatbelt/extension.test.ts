import { beforeEach, describe, it, expect, vi } from 'vitest';
import { DEFAULT_CONFIG, loadConfig } from '../../extensions/yolo-seatbelt/config.js';
import { evaluate, RuleSeverity } from '../../extensions/yolo-seatbelt/evaluate.js';
import { logDecision } from '../../extensions/yolo-seatbelt/logger.js';

vi.mock('../../extensions/yolo-seatbelt/config.js', async () => {
  const actual = await vi.importActual<typeof import('../../extensions/yolo-seatbelt/config.js')>(
    '../../extensions/yolo-seatbelt/config.js',
  );
  return { ...actual, loadConfig: vi.fn() };
});

// Mock modules
vi.mock('../../extensions/yolo-seatbelt/evaluate.js');
vi.mock('../../extensions/yolo-seatbelt/logger.js');

async function captureHandler() {
  const extensionModule = await import('../../extensions/yolo-seatbelt/index.js');
  const pi = { on: vi.fn(), registerCommand: vi.fn(), getCommands: vi.fn() } as any;
  let handler: any;
  pi.on.mockImplementation((event: string, callback: any) => {
    if (event === 'tool_call') {
      handler = callback;
    }
  });
  extensionModule.default(pi);
  return handler;
}

describe('yolo-seatbelt extension', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(loadConfig).mockReturnValue(DEFAULT_CONFIG);
  });

  it('shows configured blocked tools in /yolo-seatbelt-rules', async () => {
    vi.mocked(loadConfig).mockReturnValue({
      ...DEFAULT_CONFIG,
      blockedTools: ['slack_post', 'bash'],
    });
    const pi = { on: vi.fn(), registerCommand: vi.fn(), getCommands: vi.fn() } as any;
    let commandHandler: any;
    pi.registerCommand.mockImplementation((name: string, command: any) => {
      if (name === 'yolo-seatbelt-rules') {
        commandHandler = command.handler;
      }
    });
    const extensionModule = await import('../../extensions/yolo-seatbelt/index.js');
    extensionModule.default(pi);
    const select = vi.fn().mockResolvedValue(undefined);

    await commandHandler('', { ui: { select } });

    expect(select).toHaveBeenCalledWith(
      'yolo-seatbelt Rules',
      expect.arrayContaining(['  🛑 blockedTools: slack_post, bash']),
    );
  });

  it('blocks an exact configured tool name without inspecting input or prompting', async () => {
    const config = { ...DEFAULT_CONFIG, blockedTools: ['slack_post'] };
    vi.mocked(loadConfig).mockReturnValue(config);
    const mockCtx = {
      cwd: '/repo',
      ui: {
        confirm: vi.fn().mockResolvedValue(false),
        select: vi.fn().mockResolvedValue(undefined),
      },
    } as any;
    const handler = await captureHandler();

    const result = await handler(
      {
        toolName: 'slack_post',
        toolCallId: 'test-slack-post',
        get input() {
          throw new Error('blocked tool input should not be inspected');
        },
      },
      mockCtx,
    );

    expect(result).toEqual({
      block: true,
      reason: 'Blocked by yolo-seatbelt: tool slack_post',
    });
    expect(evaluate).not.toHaveBeenCalled();
    expect(logDecision).not.toHaveBeenCalled();
    expect(mockCtx.ui.confirm).not.toHaveBeenCalled();
  });

  it.each(['slack_poster', 'Slack_post', 'my_slack_post'])(
    'does not block a non-matching tool name: %s',
    async (toolName) => {
      const config = { ...DEFAULT_CONFIG, blockedTools: ['slack_post'] };
      vi.mocked(loadConfig).mockReturnValue(config);
      const mockCtx = {
        cwd: '/repo',
        ui: {
          confirm: vi.fn().mockResolvedValue(false),
          select: vi.fn().mockResolvedValue(undefined),
        },
      } as any;
      const handler = await captureHandler();

      const result = await handler(
        {
          toolName,
          toolCallId: `test-${toolName}`,
          input: { arbitrary: 'secret content' },
        },
        mockCtx,
      );

      expect(result).toBeUndefined();
      expect(evaluate).not.toHaveBeenCalled();
      expect(logDecision).not.toHaveBeenCalled();
      expect(mockCtx.ui.confirm).not.toHaveBeenCalled();
    },
  );

  it('blocks bash by name before command evaluation', async () => {
    const config = { ...DEFAULT_CONFIG, blockedTools: ['bash'] };
    vi.mocked(loadConfig).mockReturnValue(config);
    const mockCtx = {
      cwd: '/repo',
      ui: {
        confirm: vi.fn().mockResolvedValue(false),
        select: vi.fn().mockResolvedValue(undefined),
      },
    } as any;
    const handler = await captureHandler();

    const result = await handler(
      {
        toolName: 'bash',
        toolCallId: 'test-blocked-bash',
        get input() {
          throw new Error('blocked bash input should not be inspected');
        },
      },
      mockCtx,
    );

    expect(result).toEqual({
      block: true,
      reason: 'Blocked by yolo-seatbelt: tool bash',
    });
    expect(evaluate).not.toHaveBeenCalled();
    expect(logDecision).not.toHaveBeenCalled();
    expect(mockCtx.ui.confirm).not.toHaveBeenCalled();
  });

  it('evaluates an unblocked bash call with the loaded config', async () => {
    const config = { ...DEFAULT_CONFIG, blockedTools: ['slack_post'] };
    vi.mocked(loadConfig).mockReturnValue(config);
    const mockCtx = {
      cwd: '/repo',
      ui: {
        confirm: vi.fn().mockResolvedValue(false),
        select: vi.fn().mockResolvedValue(undefined),
      },
    } as any;
    vi.mocked(evaluate).mockReturnValue({
      decision: RuleSeverity.ALLOW,
      matchedRule: 'allow-default',
      message: 'Command matches allow pattern',
    });
    const handler = await captureHandler();

    const result = await handler(
      {
        toolName: 'bash',
        toolCallId: 'test-safe-bash',
        input: { command: 'echo hello', timeout: 30 },
      },
      mockCtx,
    );

    expect(result).toBeUndefined();
    expect(evaluate).toHaveBeenCalledWith('echo hello', config);
  });

  it('blocks rm -rf / commands', async () => {
    const mockToolCallEvent = {
      toolName: 'bash',
      toolCallId: 'test-1',
      input: { command: 'rm -rf /some/path', timeout: 30 },
    };

    const mockCtx = {
      cwd: '/repo',
      ui: {
        confirm: vi.fn().mockResolvedValue(false),
        select: vi.fn().mockResolvedValue(undefined),
      },
    } as any;

    // Mock evaluate to return BLOCK
    vi.mocked(evaluate).mockReturnValue({
      decision: RuleSeverity.BLOCK,
      matchedRule: 'rm-rf-root',
      message: 'Command matches forbidden pattern',
    });

    // Import the extension from its actual location
    const extensionModule = await import('../../extensions/yolo-seatbelt/index.js');
    const extension = extensionModule.default;
    const pi = { on: vi.fn(), registerCommand: vi.fn(), getCommands: vi.fn() } as any;
    const handlers: any[] = [];
    pi.on.mockImplementation((event: string, handler: any) => {
      handlers.push(handler);
    });
    extension(pi);

    const handler = handlers[0];
    const result = await handler(mockToolCallEvent, mockCtx);

    expect(result).toEqual({
      block: true,
      reason: 'Blocked by yolo-seatbelt: rm-rf-root',
    });
    expect(logDecision).toHaveBeenCalled();
  });

  it('asks for confirmation on rm -rf commands', async () => {
    const mockToolCallEvent = {
      toolName: 'bash',
      toolCallId: 'test-2',
      input: { command: 'rm -rf .tmp', timeout: 30 },
    };

    const mockCtx = {
      cwd: '/repo',
      ui: {
        confirm: vi.fn().mockResolvedValue(false),
        select: vi.fn().mockResolvedValue(undefined),
      },
    } as any;

    // Mock evaluate to return ASK
    vi.mocked(evaluate).mockReturnValue({
      decision: RuleSeverity.ASK,
      matchedRule: 'rm-rf',
      message: 'Command matches ask pattern',
    });

    const extensionModule = await import('../../extensions/yolo-seatbelt/index.js');
    const extension = extensionModule.default;
    const pi = { on: vi.fn(), registerCommand: vi.fn(), getCommands: vi.fn() } as any;
    const handlers: any[] = [];
    pi.on.mockImplementation((event: string, handler: any) => {
      handlers.push(handler);
    });
    extension(pi);

    const handler = handlers[0];
    const result = await handler(mockToolCallEvent, mockCtx);

    expect(result).toEqual({
      block: true,
      reason: 'Blocked by user: rm-rf',
    });
    expect(mockCtx.ui.confirm).toHaveBeenCalledWith(
      '⚠️ Risky command detected',
      'The command "rm -rf .tmp" matches a safety rule ("rm-rf").\n\nContinue?'
    );
    expect(logDecision).toHaveBeenCalled();
  });

  it('allows safe commands', async () => {
    const mockToolCallEvent = {
      toolName: 'bash',
      toolCallId: 'test-3',
      input: { command: 'echo hello', timeout: 30 },
    };

    const mockCtx = {
      cwd: '/repo',
      ui: {
        confirm: vi.fn().mockResolvedValue(true),
        select: vi.fn().mockResolvedValue(undefined),
      },
    } as any;

    // Mock evaluate to return ALLOW
    vi.mocked(evaluate).mockReturnValue({
      decision: RuleSeverity.ALLOW,
      matchedRule: 'allow-default',
      message: 'Command matches allow pattern',
    });

    const extensionModule = await import('../../extensions/yolo-seatbelt/index.js');
    const extension = extensionModule.default;
    const pi = { on: vi.fn(), registerCommand: vi.fn(), getCommands: vi.fn() } as any;
    const handlers: any[] = [];
    pi.on.mockImplementation((event: string, handler: any) => {
      handlers.push(handler);
    });
    extension(pi);

    const handler = handlers[0];
    const result = await handler(mockToolCallEvent, mockCtx);

    expect(result).toBeUndefined();
    expect(mockCtx.ui.confirm).not.toHaveBeenCalled();
    expect(logDecision).toHaveBeenCalled();
  });

  it('blocks .git protected paths', async () => {
    const mockToolCallEvent = {
      toolName: 'bash',
      toolCallId: 'test-4',
      input: { command: 'rm -rf .git/config', timeout: 30 },
    };

    const mockCtx = {
      cwd: '/repo',
      ui: {
        confirm: vi.fn().mockResolvedValue(false),
        select: vi.fn().mockResolvedValue(undefined),
      },
    } as any;

    // Mock evaluate to return BLOCK for protected path
    vi.mocked(evaluate).mockReturnValue({
      decision: RuleSeverity.BLOCK,
      matchedRule: 'protected-path',
      message: 'Command targets protected path',
    });

    const extensionModule = await import('../../extensions/yolo-seatbelt/index.js');
    const extension = extensionModule.default;
    const pi = { on: vi.fn(), registerCommand: vi.fn(), getCommands: vi.fn() } as any;
    const handlers: any[] = [];
    pi.on.mockImplementation((event: string, handler: any) => {
      handlers.push(handler);
    });
    extension(pi);

    const handler = handlers[0];
    const result = await handler(mockToolCallEvent, mockCtx);

    expect(result).toEqual({
      block: true,
      reason: 'Blocked by yolo-seatbelt: protected-path',
    });
    expect(logDecision).toHaveBeenCalled();
  });

  it('only processes bash tool calls', async () => {
    const mockNonBashEvent = {
      toolName: 'read',
      toolCallId: 'test-5',
      input: { path: '/some/file.txt' },
    };

    const mockCtx = {
      cwd: '/repo',
      ui: {
        confirm: vi.fn().mockResolvedValue(false),
        select: vi.fn().mockResolvedValue(undefined),
      },
    } as any;

    const extensionModule = await import('../../extensions/yolo-seatbelt/index.js');
    const extension = extensionModule.default;
    const pi = { on: vi.fn(), registerCommand: vi.fn(), getCommands: vi.fn() } as any;
    const handlers: any[] = [];
    pi.on.mockImplementation((event: string, handler: any) => {
      handlers.push(handler);
    });
    extension(pi);

    const handler = handlers[0];
    const result = await handler(mockNonBashEvent, mockCtx);

    // Non-bash tool calls should return undefined (allow)
    expect(result).toBeUndefined();
  });
});

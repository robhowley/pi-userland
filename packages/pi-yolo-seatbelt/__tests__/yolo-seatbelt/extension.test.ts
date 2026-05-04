import { describe, it, expect, vi } from 'vitest';
import { evaluate, Decision } from '../../extensions/yolo-seatbelt/evaluate.js';
import { logAsk, logBlock } from '../../extensions/yolo-seatbelt/logger.js';

// Mock modules
vi.mock('../../extensions/yolo-seatbelt/evaluate.js');
vi.mock('../../extensions/yolo-seatbelt/logger.js');

describe('yolo-seatbelt extension', () => {
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
      decision: Decision.BLOCK,
      matchedRule: 'block-rm-rf-root',
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
      reason: 'Blocked by yolo-seatbelt: block-rm-rf-root',
    });
    expect(logAsk).toHaveBeenCalledWith('rm -rf /some/path');
    expect(logBlock).toHaveBeenCalledWith('rm -rf /some/path', 'block-rm-rf-root');
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
      decision: Decision.ASK,
      matchedRule: 'ask-rm-rf',
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
      reason: 'Blocked by user: ask-rm-rf',
    });
    expect(mockCtx.ui.confirm).toHaveBeenCalledWith(
      '⚠️ Risky command detected',
      'The command "rm -rf .tmp" matches a safety rule ("ask-rm-rf").\n\nContinue?'
    );
    expect(logAsk).toHaveBeenCalledWith('rm -rf .tmp');
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
      decision: Decision.ALLOW,
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
    expect(logAsk).toHaveBeenCalledWith('echo hello');
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
      decision: Decision.BLOCK,
      matchedRule: 'block-protected-path',
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
      reason: 'Blocked by yolo-seatbelt: block-protected-path',
    });
    expect(logBlock).toHaveBeenCalledWith('rm -rf .git/config', 'block-protected-path');
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

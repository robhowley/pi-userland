import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import { vi } from 'vitest';
import { CheckpointStore } from '../../extensions/remembrancer/checkpoints.js';
import remembrancer from '../../extensions/remembrancer/index.js';

/** A saved outgoing TUI and registered extension, without eager storage by default. */
export function captureExtension(database = false) {
  const dir = mkdtempSync(join(tmpdir(), 'capture-extension-'));
  mkdirSync(join(dir, 'agent'));
  mkdirSync(join(dir, '.pi'));
  vi.stubEnv('PI_CODING_AGENT_DIR', join(dir, 'agent'));
  vi.stubEnv('XDG_STATE_HOME', join(dir, 'state'));
  const file = join(dir, 'outgoing.jsonl');
  writeFileSync(
    file,
    [
      { type: 'session', id: 'outgoing', cwd: dir },
      {
        type: 'message',
        id: 'promise',
        parentId: null,
        timestamp: '2026-11-01T00:00:00.000Z',
        message: { role: 'user', content: 'Send Maya the comparison' },
      },
    ]
      .map((row) => JSON.stringify(row))
      .join('\n') + '\n',
  );
  const ctx = {
    cwd: dir,
    mode: 'tui',
    hasUI: true,
    thinkingLevel: 'high',
    isProjectTrusted: () => true,
    model: {
      id: 'selected',
      provider: 'offline',
      api: 'openai-completions',
      baseUrl: 'http://127.0.0.1:1/v1',
      name: 'Selected',
      reasoning: true,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 32768,
      maxTokens: 1024,
    },
    ui: { notify: vi.fn(), confirm: vi.fn().mockResolvedValue(false) },
    sessionManager: { getSessionFile: () => file, getSessionId: () => 'outgoing' },
  } as unknown as ExtensionContext;
  const db = database ? new CheckpointStore() : undefined;
  const settings = (value: object, project = false) =>
    writeFileSync(
      join(dir, project ? '.pi' : 'agent', 'settings.json'),
      JSON.stringify({ 'pi-remembrancer': value }),
    );
  function register() {
    const handlers = new Map<string, (event: object, ctx: ExtensionContext) => unknown>();
    const tools: ToolDefinition[] = [];
    const commands = new Map<
      string,
      { handler: (args: string, ctx: ExtensionContext) => unknown }
    >();
    const send = vi.fn();
    remembrancer({
      on: (name: string, handler: (event: object, ctx: ExtensionContext) => unknown) =>
        handlers.set(name, handler),
      registerCommand: (
        name: string,
        command: { handler: (args: string, ctx: ExtensionContext) => unknown },
      ) => commands.set(name, command),
      registerTool: (tool: ToolDefinition) => tools.push(tool),
      sendUserMessage: send,
    } as unknown as ExtensionAPI);
    return { handlers, tools, commands, send };
  }
  let registered = register();
  return {
    dir,
    file,
    ctx,
    db,
    settings,
    ...registered,
    bind() {
      registered = register();
      return registered;
    },
    async close(current = ctx) {
      settings({ autoCapture: false });
      try {
        await registered.handlers.get('session_shutdown')!({ reason: 'quit' }, current);
      } finally {
        db?.close();
        vi.useRealTimers();
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
        rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}

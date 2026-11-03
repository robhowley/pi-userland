import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { expect, it } from 'vitest';
import remembrancer from '../extensions/remembrancer/index.js';

type Handler = (...args: unknown[]) => unknown;
type TestTool = {
  name: string;
  description: string;
  execute: (
    id: string,
    args: { action: string; batch?: string },
    signal: AbortSignal | undefined,
    update: unknown,
    ctx: ExtensionContext,
  ) => Promise<unknown>;
};
type ToolResponse = { content: [{ type: 'text'; text: string }] };
type ReviewResult = {
  batch?: string;
  entries?: unknown[];
  hasMore?: boolean;
  capturedTips?: number;
  finished?: boolean;
  reviewedTips?: number;
};

type FakeExtension = {
  handlers: Map<string, Handler>;
  tools: TestTool[];
  api: ExtensionAPI;
};

function fakeExtension(): FakeExtension {
  const handlers = new Map<string, Handler>();
  const tools: TestTool[] = [];
  const api = {
    on(event: string, handler: Handler) {
      handlers.set(event, handler);
    },
    registerTool(tool: TestTool) {
      tools.push(tool);
    },
  } as unknown as ExtensionAPI;
  return { handlers, tools, api };
}

function decode(response: unknown): ReviewResult {
  const text = (response as ToolResponse).content[0].text;
  return JSON.parse(text) as ReviewResult;
}

it('registers the remembrancer lifecycle and review tool without legacy names', () => {
  const extension = fakeExtension();
  remembrancer(extension.api);

  expect([...extension.handlers.keys()]).toEqual([
    'session_start',
    'session_compact',
    'session_shutdown',
  ]);
  expect(extension.tools).toHaveLength(1);
  expect(extension.tools[0]?.name).toBe('remembrancer_review');
  expect(extension.tools[0]?.description).toContain('remembrancer skill');
});

it('does not register when disabled for delegated sessions', () => {
  const previous = process.env['PI_REMEMBRANCER_DISABLED'];
  process.env['PI_REMEMBRANCER_DISABLED'] = '1';
  try {
    const extension = fakeExtension();
    remembrancer(extension.api);
    expect(extension.handlers).toEqual(new Map());
    expect(extension.tools).toEqual([]);
  } finally {
    if (previous === undefined) delete process.env['PI_REMEMBRANCER_DISABLED'];
    else process.env['PI_REMEMBRANCER_DISABLED'] = previous;
  }
});

it('captures, pages, and finishes only after all review evidence is read', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'remembrancer-extension-'));
  const previousState = process.env['XDG_STATE_HOME'];
  process.env['XDG_STATE_HOME'] = join(dir, 'state');
  const file = join(dir, 'session.jsonl');
  const longText = 'x'.repeat(12_050);
  writeFileSync(
    file,
    [
      JSON.stringify({ type: 'session', id: 'session', cwd: dir }),
      JSON.stringify({
        type: 'message',
        id: 'root',
        parentId: null,
        timestamp: '2026-01-30',
        message: { role: 'user', content: 'Review this session' },
      }),
      JSON.stringify({
        type: 'message',
        id: 'answer',
        parentId: 'root',
        timestamp: '2026-01-30',
        message: { role: 'assistant', content: [{ type: 'text', text: longText }] },
      }),
      '',
    ].join('\n'),
  );

  const extension = fakeExtension();
  remembrancer(extension.api);
  const context = {
    hasUI: false,
    ui: { notify() {} },
    sessionManager: {
      getSessionFile: () => file,
      getSessionId: () => 'session',
      getLeafId: () => 'answer',
    },
  } as unknown as ExtensionContext;
  const start = extension.handlers.get('session_start');
  const shutdown = extension.handlers.get('session_shutdown');
  const tool = extension.tools[0];
  if (!start || !shutdown || !tool)
    throw new Error('Extension did not register its runtime contract');

  try {
    await start({}, context);
    const firstPage = decode(
      await tool.execute('call-1', { action: 'begin' }, undefined, undefined, context),
    );
    expect(firstPage.capturedTips).toBe(1);
    expect(firstPage.hasMore).toBe(true);
    expect(firstPage.entries).toEqual(expect.any(Array));

    const batch = firstPage.batch;
    expect(typeof batch).toBe('string');
    await expect(
      tool.execute(
        'call-2',
        { action: 'finish', batch: batch as string },
        undefined,
        undefined,
        context,
      ),
    ).rejects.toThrow(/Read all evidence pages/);

    const secondPage = decode(
      await tool.execute(
        'call-3',
        { action: 'next', batch: batch as string },
        undefined,
        undefined,
        context,
      ),
    );
    expect(secondPage.hasMore).toBe(false);

    const finished = decode(
      await tool.execute(
        'call-4',
        { action: 'finish', batch: batch as string },
        undefined,
        undefined,
        context,
      ),
    );
    expect(finished).toEqual({ finished: true, reviewedTips: 1 });
  } finally {
    await shutdown({}, context);
    if (previousState === undefined) delete process.env['XDG_STATE_HOME'];
    else process.env['XDG_STATE_HOME'] = previousState;
    rmSync(dir, { recursive: true, force: true });
  }
});

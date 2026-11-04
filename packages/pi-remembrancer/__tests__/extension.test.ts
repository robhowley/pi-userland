import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { expect, it, vi } from 'vitest';
import remembrancer from '../extensions/remembrancer/index.js';

vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>();
  return { ...fs, readFileSync: vi.fn(fs.readFileSync) };
});

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
  entries?: { text: string; entryId: string; offset: number; continues: boolean }[];
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

  expect(extension.tools).toHaveLength(1);
  expect(extension.tools[0]?.name).toBe('remembrancer_review');
  expect(extension.tools[0]?.description).toContain('remembrancer skill');
});

it.each(['PI_REMEMBRANCER_DISABLED', 'PI_SUBAGENT_DEPTH'])(
  'does not enroll delegated sessions with %s',
  (variable) => {
    const previous = process.env[variable];
    process.env[variable] = '1';
    try {
      const extension = fakeExtension();
      remembrancer(extension.api);
      expect(extension.handlers).toEqual(new Map());
      expect(extension.tools).toEqual([]);
    } finally {
      if (previous === undefined) delete process.env[variable];
      else process.env[variable] = previous;
    }
  },
);

it('pages faithfully, cancels without consuming, persists finish and isolates later appends', async () => {
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
    },
  } as unknown as ExtensionContext;
  const start = extension.handlers.get('session_start');
  const shutdown = extension.handlers.get('session_shutdown');
  const tool = extension.tools[0];
  if (!start || !shutdown || !tool)
    throw new Error('Extension did not register its runtime contract');

  try {
    writeFileSync(join(dir, 'unenrolled.jsonl'), 'invalid history, not eligible');
    vi.mocked(readFileSync).mockClear();
    await start({}, context);
    expect(readFileSync).not.toHaveBeenCalled();
    const firstPage = decode(
      await tool.execute('call-1', { action: 'begin' }, undefined, undefined, context),
    );
    expect(readFileSync).toHaveBeenCalledTimes(1);
    expect(readFileSync).toHaveBeenCalledWith(file, 'utf8');
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
    const chunks = [...firstPage.entries!, ...secondPage.entries!].filter(
      (entry) => entry.entryId === 'answer',
    );
    expect(chunks.map((entry) => entry.text).join('')).toBe(longText);
    expect(chunks[0]?.offset).toBe(0);
    expect(chunks[1]?.offset).toBe(chunks[0]!.text.length);
    expect(chunks.map((entry) => entry.continues)).toEqual([true, false]);
    appendFileSync(
      file,
      JSON.stringify({
        type: 'message',
        id: 'later',
        parentId: 'answer',
        message: { role: 'user', content: 'later' },
      }) + '\n',
    );

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
    await shutdown({}, context);
    await start({}, context);
    const call = async (action: string, token?: string) =>
      decode(
        await tool.execute(
          'call',
          { action, ...(token === undefined ? {} : { batch: token }) },
          undefined,
          undefined,
          context,
        ),
      );
    const later = await call('begin');
    expect(later.entries?.map((entry) => entry.text)).toEqual(['later']);
    await expect(call('next', 'wrong-token')).rejects.toThrow(/matching open review/);
    await expect(call('begin')).rejects.toThrow(/already open/);
    await call('cancel', later.batch);
    await shutdown({}, context);
    await start({}, context);
    const retry = await call('begin');
    expect(retry.entries).toEqual(later.entries);
    await call('finish', retry.batch);
    const empty = await call('begin');
    expect(empty.entries).toEqual([]);
    expect(empty.capturedTips).toBe(0);
    await call('cancel', empty.batch);
  } finally {
    await shutdown({}, context);
    if (previousState === undefined) delete process.env['XDG_STATE_HOME'];
    else process.env['XDG_STATE_HOME'] = previousState;
    rmSync(dir, { recursive: true, force: true });
  }
});

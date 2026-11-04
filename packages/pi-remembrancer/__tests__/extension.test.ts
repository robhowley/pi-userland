import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
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

function contextFor(cwd: string, file?: string): ExtensionContext {
  return {
    cwd,
    isProjectTrusted: () => true,
    hasUI: false,
    ui: { notify() {} },
    sessionManager: {
      getSessionFile: () => file,
      getSessionId: () => 'session',
    },
  } as unknown as ExtensionContext;
}

it('registers the remembrancer lifecycle and review tool after enabled startup', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'remembrancer-extension-startup-'));
  const previousAgentDir = process.env['PI_CODING_AGENT_DIR'];
  process.env['PI_CODING_AGENT_DIR'] = join(dir, 'agent');
  const extension = fakeExtension();
  remembrancer(extension.api);
  const start = extension.handlers.get('session_start');
  const shutdown = extension.handlers.get('session_shutdown');
  if (!start || !shutdown) throw new Error('Extension did not register its lifecycle');

  try {
    await start({}, contextFor(dir));
    expect(extension.tools).toHaveLength(1);
    expect(extension.tools[0]?.name).toBe('remembrancer_review');
    expect(extension.tools[0]?.description).toContain('remembrancer skill');
  } finally {
    await shutdown({}, contextFor(dir));
    if (previousAgentDir === undefined) delete process.env['PI_CODING_AGENT_DIR'];
    else process.env['PI_CODING_AGENT_DIR'] = previousAgentDir;
    rmSync(dir, { recursive: true, force: true });
  }
});

it('does not register or read session history when disabled by settings', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'remembrancer-extension-disabled-'));
  const agentDir = join(dir, 'agent');
  const stateDir = join(dir, 'state');
  const file = join(dir, 'session.jsonl');
  const previousAgentDir = process.env['PI_CODING_AGENT_DIR'];
  const previousState = process.env['XDG_STATE_HOME'];
  process.env['PI_CODING_AGENT_DIR'] = agentDir;
  process.env['XDG_STATE_HOME'] = stateDir;
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(
    join(agentDir, 'settings.json'),
    JSON.stringify({ 'pi-remembrancer': { disabled: true } }),
  );
  writeFileSync(file, 'session history should not be read');

  const extension = fakeExtension();
  remembrancer(extension.api);
  const start = extension.handlers.get('session_start');
  const shutdown = extension.handlers.get('session_shutdown');
  if (!start || !shutdown) throw new Error('Extension did not register its lifecycle');

  try {
    vi.mocked(readFileSync).mockClear();
    await start({}, contextFor(dir, file));
    expect(extension.tools).toEqual([]);
    expect(readFileSync).not.toHaveBeenCalledWith(file, 'utf8');
    expect(existsSync(join(stateDir, 'pi-remembrancer', 'checkpoints.sqlite3'))).toBe(false);
  } finally {
    await shutdown({}, contextFor(dir, file));
    if (previousAgentDir === undefined) delete process.env['PI_CODING_AGENT_DIR'];
    else process.env['PI_CODING_AGENT_DIR'] = previousAgentDir;
    if (previousState === undefined) delete process.env['XDG_STATE_HOME'];
    else process.env['XDG_STATE_HOME'] = previousState;
    rmSync(dir, { recursive: true, force: true });
  }
});

it('ignores the legacy disable and depth environment variables', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'remembrancer-extension-env-'));
  const previousAgentDir = process.env['PI_CODING_AGENT_DIR'];
  const previousDisabled = process.env['PI_REMEMBRANCER_DISABLED'];
  const previousDepth = process.env['PI_SUBAGENT_DEPTH'];
  process.env['PI_CODING_AGENT_DIR'] = join(dir, 'agent');
  process.env['PI_REMEMBRANCER_DISABLED'] = '1';
  process.env['PI_SUBAGENT_DEPTH'] = '1';
  const extension = fakeExtension();
  remembrancer(extension.api);
  const start = extension.handlers.get('session_start');
  const shutdown = extension.handlers.get('session_shutdown');
  if (!start || !shutdown) throw new Error('Extension did not register its lifecycle');

  try {
    await start({}, contextFor(dir));
    expect(extension.tools).toHaveLength(1);
  } finally {
    await shutdown({}, contextFor(dir));
    if (previousAgentDir === undefined) delete process.env['PI_CODING_AGENT_DIR'];
    else process.env['PI_CODING_AGENT_DIR'] = previousAgentDir;
    if (previousDisabled === undefined) delete process.env['PI_REMEMBRANCER_DISABLED'];
    else process.env['PI_REMEMBRANCER_DISABLED'] = previousDisabled;
    if (previousDepth === undefined) delete process.env['PI_SUBAGENT_DEPTH'];
    else process.env['PI_SUBAGENT_DEPTH'] = previousDepth;
    rmSync(dir, { recursive: true, force: true });
  }
});

it('releases an open review across a fresh disabled runtime without advancing checkpoints', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'remembrancer-extension-reload-'));
  const agentDir = join(dir, 'agent');
  const stateDir = join(dir, 'state');
  const settingsFile = join(agentDir, 'settings.json');
  const file = join(dir, 'session.jsonl');
  const previousAgentDir = process.env['PI_CODING_AGENT_DIR'];
  const previousState = process.env['XDG_STATE_HOME'];
  process.env['PI_CODING_AGENT_DIR'] = agentDir;
  process.env['XDG_STATE_HOME'] = stateDir;
  mkdirSync(agentDir, { recursive: true });
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
        message: { role: 'assistant', content: [{ type: 'text', text: 'one commitment' }] },
      }),
      '',
    ].join('\n'),
  );

  const context = contextFor(dir, file);
  const enabledSettings = JSON.stringify({ 'pi-remembrancer': { disabled: false } });
  const disabledSettings = JSON.stringify({ 'pi-remembrancer': { disabled: true } });
  writeFileSync(settingsFile, enabledSettings);
  const firstRuntime = fakeExtension();
  remembrancer(firstRuntime.api);
  const firstStart = firstRuntime.handlers.get('session_start');
  const firstShutdown = firstRuntime.handlers.get('session_shutdown');
  if (!firstStart || !firstShutdown)
    throw new Error('First runtime did not register its lifecycle');

  let secondShutdown: Handler | undefined;
  let thirdShutdown: Handler | undefined;
  try {
    await firstStart({}, context);
    const firstTool = firstRuntime.tools[0];
    if (!firstTool) throw new Error('First runtime did not register the review tool');
    const firstReview = decode(
      await firstTool.execute('call-1', { action: 'begin' }, undefined, undefined, context),
    );
    expect(firstReview.capturedTips).toBe(1);
    expect(firstReview.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          entryId: 'answer',
          text: 'one commitment',
          offset: 0,
          continues: false,
        }),
      ]),
    );

    await firstShutdown({}, context);
    writeFileSync(settingsFile, disabledSettings);
    const secondRuntime = fakeExtension();
    remembrancer(secondRuntime.api);
    const secondStart = secondRuntime.handlers.get('session_start');
    secondShutdown = secondRuntime.handlers.get('session_shutdown');
    if (!secondStart || !secondShutdown)
      throw new Error('Second runtime did not register its lifecycle');
    await secondStart({}, context);
    expect(secondRuntime.tools).toEqual([]);
    await secondShutdown({}, context);

    writeFileSync(settingsFile, enabledSettings);
    const thirdRuntime = fakeExtension();
    remembrancer(thirdRuntime.api);
    const thirdStart = thirdRuntime.handlers.get('session_start');
    thirdShutdown = thirdRuntime.handlers.get('session_shutdown');
    if (!thirdStart || !thirdShutdown)
      throw new Error('Third runtime did not register its lifecycle');
    await thirdStart({}, context);
    const thirdTool = thirdRuntime.tools[0];
    if (!thirdTool) throw new Error('Third runtime did not register the review tool');
    const resumedReview = decode(
      await thirdTool.execute('call-2', { action: 'begin' }, undefined, undefined, context),
    );
    expect(resumedReview.capturedTips).toBe(1);
    expect(resumedReview.entries).toEqual(firstReview.entries);
    await thirdTool.execute(
      'call-3',
      { action: 'cancel', batch: resumedReview.batch as string },
      undefined,
      undefined,
      context,
    );
  } finally {
    await thirdShutdown?.({}, context);
    await secondShutdown?.({}, context);
    await firstShutdown({}, context);
    if (previousAgentDir === undefined) delete process.env['PI_CODING_AGENT_DIR'];
    else process.env['PI_CODING_AGENT_DIR'] = previousAgentDir;
    if (previousState === undefined) delete process.env['XDG_STATE_HOME'];
    else process.env['XDG_STATE_HOME'] = previousState;
    rmSync(dir, { recursive: true, force: true });
  }
});

it('pages faithfully, cancels without consuming, persists finish and isolates later appends', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'remembrancer-extension-'));
  const previousAgentDir = process.env['PI_CODING_AGENT_DIR'];
  const previousState = process.env['XDG_STATE_HOME'];
  process.env['PI_CODING_AGENT_DIR'] = join(dir, 'agent');
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
  const context = contextFor(dir, file);
  const start = extension.handlers.get('session_start');
  const shutdown = extension.handlers.get('session_shutdown');
  if (!start || !shutdown) throw new Error('Extension did not register its runtime contract');

  try {
    writeFileSync(join(dir, 'unenrolled.jsonl'), 'invalid history, not eligible');
    vi.mocked(readFileSync).mockClear();
    await start({}, context);
    const tool = extension.tools[0];
    if (!tool) throw new Error('Extension did not register its review tool');
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
    if (previousAgentDir === undefined) delete process.env['PI_CODING_AGENT_DIR'];
    else process.env['PI_CODING_AGENT_DIR'] = previousAgentDir;
    if (previousState === undefined) delete process.env['XDG_STATE_HOME'];
    else process.env['XDG_STATE_HOME'] = previousState;
    rmSync(dir, { recursive: true, force: true });
  }
});

import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import { afterEach, expect, it, vi } from 'vitest';
import { CheckpointStore } from '../extensions/remembrancer/checkpoints.js';
import * as evidence from '../extensions/remembrancer/evidence.js';
import * as discovery from '../extensions/remembrancer/discovery.js';
import * as reviewer from '../extensions/remembrancer/reviewer.js';
import remembrancer, {
  getRemembrancerArgumentCompletions,
  parseRemembrancerCommandArgs,
} from '../extensions/remembrancer/index.js';
import type { Proposal } from '../extensions/remembrancer/proposals.js';

vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  execFile: vi.fn(() => {
    throw new Error('Unexpected task execution');
  }),
}));

const directories: string[] = [];
const shutdowns: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const shutdown of shutdowns.splice(0)) await shutdown();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  directories.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
  vi.mocked(execFile).mockClear();
});
function setup(autoCapture?: boolean, disabled = false, mode: unknown = 'tui') {
  const dir = mkdtempSync(join(tmpdir(), 'remembrancer-proposal-command-'));
  directories.push(dir);
  const agent = join(dir, 'agent');
  mkdirSync(agent);
  vi.stubEnv('PI_CODING_AGENT_DIR', agent);
  vi.stubEnv('XDG_STATE_HOME', join(dir, 'state'));
  writeFileSync(
    join(agent, 'settings.json'),
    JSON.stringify({
      'pi-remembrancer': { ...(autoCapture === undefined ? {} : { autoCapture }), disabled },
    }),
  );
  const file = join(dir, 'session.jsonl');
  writeFileSync(
    file,
    [
      { type: 'session', id: 'session', cwd: dir },
      {
        type: 'message',
        id: 'leaf',
        parentId: null,
        timestamp: '2026-01-01',
        message: { role: 'user', content: 'Send comparison' },
      },
    ]
      .map((item) => JSON.stringify(item))
      .join('\n'),
  );
  const store = new CheckpointStore();
  store.claimReview();
  const capture = store.prepareCapture({ file, sessionId: 'session' });
  capture.page();
  const submission = {
    change: {
      operation: 'add' as const,
      fields: { description: 'Send comparison' },
      annotations: [],
    },
    expected: null,
    question: null,
    explanation: 'Promised',
    references: [
      {
        sessionId: 'session',
        branchId: 'leaf',
        entryId: 'leaf',
        editId: null,
        offset: 0,
        quote: 'Send comparison',
      },
    ],
  };
  const proposals = store.finishCapture(capture.id, [submission, submission, submission]);
  store.releaseReview();
  store.dismissProposal(proposals[1]!.id, 1);
  store.claimProposal(proposals[2]!.id, 1, null);
  store.close();
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
  let command: { handler: (args: string, ctx: ExtensionContext) => Promise<void> };
  const sendUserMessage = vi.fn();
  const tools = new Map<string, ToolDefinition>();
  remembrancer({
    on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) =>
      handlers.set(name, handler),
    registerCommand: (_name: string, definition: typeof command) => {
      command = definition;
    },
    registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
    sendUserMessage,
  } as unknown as ExtensionAPI);
  const notify = vi.fn();
  type Factory = Parameters<ExtensionContext['ui']['custom']>[0];
  const custom = vi.fn(async (factory: Factory) => {
    const component = await factory(
      { requestRender() {} } as Parameters<Factory>[0],
      { fg: (_color: string, text: string) => text } as Parameters<Factory>[1],
      {
        matches: (data: string, key: string) => key === 'tui.select.cancel' && data === '\u001b',
      } as Parameters<Factory>[2],
      () => {},
    );
    expect(component.render(100).join('\n')).toContain('Task proposals');
    return 'close';
  });
  const ctx = {
    cwd: dir,
    mode,
    hasUI: true,
    isProjectTrusted: () => true,
    isIdle: () => true,
    ui: { custom, notify },
    sessionManager: { getSessionFile: () => file, getSessionId: () => 'session' },
  } as unknown as ExtensionContext;
  Object.defineProperties(ctx, {
    model: {
      get() {
        throw new Error('Unexpected model access');
      },
    },
    modelRegistry: {
      get() {
        throw new Error('Unexpected model registry access');
      },
    },
  });
  shutdowns.push(async () => handlers.get('session_shutdown')!({}, { ...ctx, mode: 'print' }));
  return {
    dir,
    agent,
    proposals,
    ctx,
    command: command!,
    handlers,
    notify,
    custom,
    sendUserMessage,
    tools,
  };
}

it.each([undefined, false, true])(
  'startup uses only the pending database count with capture %s',
  async (flag) => {
    const f = setup(flag);
    const reads = vi.spyOn(evidence, 'readSession').mockImplementation(() => {
      throw new Error('Unexpected source read');
    });
    const scans = vi.spyOn(discovery, 'discoverSources').mockImplementation(() => {
      throw new Error('Unexpected archive scan');
    });
    const models = vi.spyOn(reviewer, 'runReviewer').mockImplementation(async () => {
      throw new Error('Unexpected reviewer');
    });
    const count = vi.spyOn(CheckpointStore.prototype, 'proposalCount');
    const rows = vi.spyOn(CheckpointStore.prototype, 'proposals');
    await f.handlers.get('session_start')!({}, f.ctx);
    expect(f.notify).toHaveBeenCalledExactlyOnceWith(
      '1 task proposals · /remembrancer proposals',
      'info',
    );
    expect(count).toHaveBeenCalledExactlyOnceWith();
    expect(rows).not.toHaveBeenCalled();
    expect(reads).not.toHaveBeenCalled();
    expect(scans).not.toHaveBeenCalled();
    expect(models).not.toHaveBeenCalled();
    expect(execFile).not.toHaveBeenCalled();
    expect(f.sendUserMessage).not.toHaveBeenCalled();
    expect(f.custom).not.toHaveBeenCalled();
    writeFileSync(
      join(f.agent, 'settings.json'),
      JSON.stringify({ 'pi-remembrancer': { disabled: true } }),
    );
    await f.handlers.get('session_start')!({}, f.ctx);
    await f.command.handler('proposals', f.ctx);
    expect(count).toHaveBeenCalledOnce();
    expect(f.custom).not.toHaveBeenCalled();
    const persisted = new CheckpointStore();
    expect(persisted.proposals()).toHaveLength(3);
    persisted.close();
  },
);

it.each([undefined, false, true])(
  'proposal command is model-free and independent of capture %s',
  async (flag) => {
    const f = setup(flag);
    const source = vi.spyOn(evidence, 'readSession');
    await f.command.handler('proposals', f.ctx);
    expect(f.custom).toHaveBeenCalledOnce();
    expect(source).not.toHaveBeenCalled();
    expect(
      vi.mocked(execFile).mock.calls.every((call) => (call[1] as string[]).at(-1) === 'export'),
    ).toBe(true);
    expect(f.sendUserMessage).not.toHaveBeenCalled();
  },
);

it.each(['rpc', 'json', 'print', undefined])(
  'proposal command refuses %s before database, source, task or UI access',
  async (mode) => {
    const f = setup(false, false, mode);
    const count = vi.spyOn(CheckpointStore.prototype, 'proposalCount');
    const rows = vi.spyOn(CheckpointStore.prototype, 'proposals');
    const source = vi.spyOn(evidence, 'readSession');
    await expect(
      f.command.handler('proposals', { ...f.ctx, mode } as ExtensionContext),
    ).rejects.toThrow(/TUI/);
    expect(count).not.toHaveBeenCalled();
    expect(rows).not.toHaveBeenCalled();
    expect(source).not.toHaveBeenCalled();
    expect(execFile).not.toHaveBeenCalled();
    expect(f.custom).not.toHaveBeenCalled();
    expect(f.sendUserMessage).not.toHaveBeenCalled();
  },
);

it('parses only the exact proposal command and completes it without a model turn', () => {
  expect(parseRemembrancerCommandArgs(' proposals ')).toEqual({ ok: true, mode: 'proposals' });
  expect(parseRemembrancerCommandArgs('proposals extra').ok).toBe(false);
  expect(getRemembrancerArgumentCompletions('pro')).toEqual([
    expect.objectContaining({ value: 'proposals', label: 'proposals' }),
  ]);
  expect(getRemembrancerArgumentCompletions('proposals ')).toBeNull();
});

it.each(['rpc', 'json', 'print'] as const)(
  'reads saved capture proposals in %s with capture off and no manual review lock',
  async (mode) => {
    const f = setup(false, false, mode);
    const db = new CheckpointStore();
    const original = f.proposals[0]!;
    db.editProposal(original.id, original.revision, {
      change: {
        operation: 'add',
        fields: { description: 'Send edited comparison' },
        annotations: [],
      },
      expected: null,
      question: null,
    });
    const saved = db.proposals();
    const coverage = db.reviewed();
    const sources = db.sources();
    await f.handlers.get('session_start')!({}, f.ctx);
    const tool = f.tools.get('remembrancer_proposals')!;
    const read = async (args = {}) => {
      const result = await tool.execute('read', args, undefined, undefined, f.ctx);
      const content = result.content[0]!;
      if (content.type !== 'text') throw new Error('Expected JSON text');
      expect(Buffer.byteLength(content.text)).toBeLessThanOrEqual(50 * 1024);
      return JSON.parse(content.text);
    };
    const reads = vi.spyOn(evidence, 'readSession').mockImplementation(() => {
      throw new Error('Unexpected transcript read');
    });
    const scans = vi.spyOn(discovery, 'discoverSources');
    const models = vi.spyOn(reviewer, 'runReviewer');
    // Another owner holds the review lock. Proposal reads do not claim it.
    db.claimReview();
    try {
      for (let offset = 0; offset < saved.length; offset++) {
        expect(await read(offset === 0 ? {} : { offset })).toEqual({
          proposals: [saved[offset]],
          nextOffset: offset + 1,
        });
      }
      expect(await read({ offset: saved.length })).toEqual({ proposals: [], nextOffset: null });
      expect(db.proposals()).toEqual(saved);
      expect(db.reviewed()).toEqual(coverage);
      expect(db.sources()).toEqual(sources);
      expect(reads).not.toHaveBeenCalled();
      expect(scans).not.toHaveBeenCalled();
      expect(models).not.toHaveBeenCalled();
      expect(execFile).not.toHaveBeenCalled();
      expect(f.custom).not.toHaveBeenCalled();
    } finally {
      db.releaseReview();
      db.close();
      reads.mockRestore();
    }
    // Capture already advanced coverage. Manual begin has no evidence, but saved proposals remain.
    const review = f.tools.get('remembrancer_review')!;
    const beginResult = await review.execute(
      'begin',
      { action: 'begin' },
      undefined,
      undefined,
      f.ctx,
    );
    const content = beginResult.content[0]!;
    if (content.type !== 'text') throw new Error('Expected JSON text');
    const begin = JSON.parse(content.text);
    expect(begin).toMatchObject({ status: 'already-covered', groups: [], hasMore: false });
    expect(await read()).toEqual({ proposals: [saved[0]], nextOffset: 1 });
    await review.execute(
      'finish',
      { action: 'finish', batch: begin.batch },
      undefined,
      undefined,
      f.ctx,
    );
    const after = new CheckpointStore();
    expect(after.proposals()).toEqual(saved);
    expect(after.reviewed()).toEqual(coverage);
    after.close();
  },
);

it('does not register proposal reads when disabled', async () => {
  const f = setup(false, true, 'print');
  await f.handlers.get('session_start')!({}, f.ctx);
  expect(f.tools.size).toBe(0);
});

it('ordinary non-TUI manual finish leaves stored proposal decisions untouched', async () => {
  const f = setup(false);
  const before = new CheckpointStore();
  const proposals: Proposal[] = before.proposals();
  const coverage = before.reviewed();
  before.close();
  // Current covered source plus an unavailable source retains partial manual completion.
  const enroll = new CheckpointStore();
  enroll.enroll('missing', join(f.dir, 'missing.jsonl'));
  enroll.close();
  let tool: {
    name: string;
    execute: (
      id: string,
      args: unknown,
      signal: undefined,
      update: undefined,
      ctx: ExtensionContext,
    ) => Promise<{ content: { text: string }[] }>;
  };
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
  remembrancer({
    on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) =>
      handlers.set(name, handler),
    registerCommand() {},
    registerTool: (definition: typeof tool) => {
      if (definition.name === 'remembrancer_review') tool = definition;
    },
  } as unknown as ExtensionAPI);
  const ctx = { ...f.ctx, mode: 'print' as const };
  shutdowns.push(async () => handlers.get('session_shutdown')!({}, ctx));
  await handlers.get('session_start')!({}, ctx);
  const begin = JSON.parse(
    (await tool!.execute('begin', { action: 'begin' }, undefined, undefined, ctx)).content[0]!.text,
  );
  expect(begin.incomplete).toBe(true);
  const finish = JSON.parse(
    (
      await tool!.execute(
        'finish',
        { action: 'finish', batch: begin.batch },
        undefined,
        undefined,
        ctx,
      )
    ).content[0]!.text,
  );
  expect(finish).toMatchObject({ finished: true, status: 'partial' });
  const after = new CheckpointStore();
  expect(after.proposals()).toEqual(proposals);
  expect(after.reviewed()).toEqual(coverage);
  after.close();
  expect(execFile).not.toHaveBeenCalled();
  expect(f.custom).not.toHaveBeenCalled();
});

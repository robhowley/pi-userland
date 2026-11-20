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
import { captureJob } from './fixtures/capture-job.js';
import * as evidence from '../extensions/remembrancer/evidence.js';
import * as discovery from '../extensions/remembrancer/discovery.js';
import * as reviewer from '../extensions/remembrancer/reviewer.js';
import remembrancer, {
  getRemembrancerArgumentCompletions,
  parseRemembrancerCommandArgs,
} from '../extensions/remembrancer/index.js';
import type { Proposal } from '../extensions/remembrancer/proposals.js';
import { sourceText } from '../extensions/remembrancer/proposal-ui.js';

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
function setup(
  autoCapture?: boolean,
  disabled = false,
  mode: unknown = 'tui',
  sourceText = 'Send comparison',
  excerpt = { offset: 0, quote: sourceText },
) {
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
        message: { role: 'user', content: sourceText },
      },
    ]
      .map((item) => JSON.stringify(item))
      .join('\n'),
  );
  const store = new CheckpointStore();
  const { owner, attempt, review } = captureJob(store, { file, sessionId: 'session' });
  while (review.page()['hasMore']) {
    // Consume every frozen page before seeding the disposable proposal rows.
  }
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
        ...excerpt,
      },
    ],
  };
  const proposals = store.finishCaptureJob(owner, attempt, [submission, submission, submission]);
  owner.release();
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
      { terminal: { columns: 100, rows: 30 }, requestRender() {} } as Parameters<Factory>[0],
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

it.each([
  { prefix: '', quote: 'Send comparison' },
  { prefix: 'DISTANT_PREFIX' + '😀'.repeat(50_000), quote: 'Send comparison' + 'x'.repeat(4096) },
])(
  'Source shows same-message qualifiers around a bounded saved excerpt ($quote.length units)',
  ({ prefix, quote }) => {
    const before = 'Only after approval: ';
    const after = ', and only to the approved recipients.';
    const transcript = prefix + before + quote + after + '😀'.repeat(50_000) + 'DISTANT_SUFFIX';
    const f = setup(false, false, 'tui', transcript, {
      offset: prefix.length + before.length,
      quote,
    });
    const proposal = f.proposals[0]!;
    const lastPage = Math.ceil(quote.length / 2048) - 1;
    for (const page of new Set([0, lastPage])) {
      const text = sourceText(proposal, 0, page);
      const context = JSON.parse(text.split('saved branch):\n')[1]!.split('\n')[0]!);
      const selected = context.selected;
      expect(selected.text).toBe(
        transcript.slice(selected.offset, selected.offset + selected.text.length),
      );
      expect(selected.text.length).toBeLessThanOrEqual(2049 + 512);
      expect(selected.text.charCodeAt(0) >= 0xdc00 && selected.text.charCodeAt(0) <= 0xdfff).toBe(
        false,
      );
      const last = selected.text.charCodeAt(selected.text.length - 1);
      expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
      if (page === 0) expect(selected.text).toContain(before);
      if (page === lastPage) expect(selected.text).toContain(after);
      const saved = JSON.parse(
        text.split('Saved quote fragment (JSON, exact):\n')[1]!.split('\n')[0]!,
      );
      expect(saved).toBe(quote.slice(page * 2048, (page + 1) * 2048));
      expect(text).not.toContain('DISTANT_PREFIX');
      expect(text).not.toContain('DISTANT_SUFFIX');
      expect(text.length).toBeLessThan(10_000);
    }
    expect(execFile).not.toHaveBeenCalled();
  },
);

it.each([undefined, false, true])(
  'startup reads committed notice generation/count with capture %s',
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
    const count = vi.spyOn(CheckpointStore.prototype, 'proposalNotice');
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
      const listed = await read();
      expect(listed.proposals.map((item: { id: string }) => item.id)).toEqual(
        saved.map((item) => item.id),
      );
      expect(listed.nextOffset).toBeNull();
      for (const proposal of saved) {
        const detail = await read({
          action: 'detail',
          id: proposal.id,
          revision: proposal.revision,
        });
        expect(JSON.parse(detail.json)).toEqual(
          Object.fromEntries(Object.entries(proposal).filter(([key]) => key !== 'sources')),
        );
        expect(detail.next).toBeNull();
        const evidence = await read({
          action: 'evidence',
          id: proposal.id,
          revision: proposal.revision,
        });
        expect(evidence.entries.map((entry: { quote: string }) => entry.quote)).toEqual(
          proposal.sources.map((item) => item.quote),
        );
      }
      expect(await read({ offset: saved.length })).toEqual({
        action: 'list',
        proposals: [],
        nextOffset: null,
      });
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
    expect((await read()).proposals.map((item: { id: string }) => item.id)).toEqual(
      saved.map((item) => item.id),
    );
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

it.each(['detail', 'evidence'] as const)(
  'manual %s errors discard partial reads and allow a fresh list/current read without writes',
  async (action) => {
    const huge = '😀\\"\\n'.repeat(30_000);
    const f = setup(false, false, 'print', huge);
    const db = new CheckpointStore();
    const original = f.proposals[0]!;
    const draft = {
      change: { operation: 'add' as const, fields: { description: huge }, annotations: [] },
      expected: null,
      question: null,
    };
    db.editProposal(original.id, original.revision, draft);
    const current = db.proposal(original.id)!;
    await f.handlers.get('session_start')!({}, f.ctx);
    const tool = f.tools.get('remembrancer_proposals')!;
    const read = async (args: object) => {
      const result = await tool.execute('read', args, undefined, undefined, f.ctx);
      const block = result.content[0]!;
      if (block.type !== 'text') throw new Error('Expected text');
      expect(Buffer.byteLength(block.text)).toBeLessThanOrEqual(51_200);
      return JSON.parse(block.text);
    };
    const snapshot = () => ({
      proposals: db.proposals(),
      coverage: db.reviewed(),
      notice: db.proposalNotice(),
    });
    const before = snapshot();
    const args = { action, id: current.id, revision: current.revision };
    const first = await read(args);
    expect(first.next).not.toBeNull();
    let restored = '';
    for (let page = first; page; page = page.next ? await read(page.next) : null) {
      if (action === 'detail') {
        expect(page.position).toBe(restored.length);
        restored += page.json;
      } else {
        for (const entry of page.entries) {
          expect(entry.quotePosition).toBe(restored.length);
          restored += entry.quote;
        }
      }
    }
    if (action === 'detail')
      expect(JSON.parse(restored).draft.change.fields.description).toBe(huge);
    else expect(restored).toBe(huge);
    expect(snapshot()).toEqual(before);
    db.editProposal(current.id, current.revision, { ...draft, question: 'Clarify this' });
    const afterEdit = snapshot();
    const freshRevision = db.proposal(current.id)!.revision;
    await expect(read(args)).rejects.toThrow(/Stale proposal/);
    await expect(read(first.next)).rejects.toThrow(/Stale proposal/);
    const refreshedList = await read({});
    expect(refreshedList.proposals).toHaveLength(3);
    expect(
      refreshedList.proposals.find((item: { id: string }) => item.id === current.id).revision,
    ).toBe(freshRevision);
    const refreshed = await read({ ...args, revision: freshRevision });
    expect(refreshed.revision).toBe(freshRevision);
    const lookup = vi
      .spyOn(CheckpointStore.prototype, 'proposal')
      .mockImplementation(() => undefined);
    await expect(read(refreshed.next)).rejects.toThrow(/Missing proposal/);
    await expect(read({ ...args, revision: freshRevision })).rejects.toThrow(/Missing proposal/);
    expect(snapshot()).toEqual(afterEdit);
    lookup.mockRestore();
    db.close();
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

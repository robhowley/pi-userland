import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ExtensionContext, ToolDefinition } from '@earendil-works/pi-coding-agent';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CheckpointStore } from '../extensions/remembrancer/checkpoints.js';
import { prepareReview } from '../extensions/remembrancer/evidence.js';
import { preserveHandoff } from '../extensions/remembrancer/capture-handoff.js';
import {
  launchCaptureWorker,
  runCaptureWorker,
} from '../extensions/remembrancer/capture-worker.js';
import { captureExecution } from '../extensions/remembrancer/config.js';
import { captureExtension } from './fixtures/capture-extension.js';
import { runReviewer, type ReviewerInput } from '../extensions/remembrancer/reviewer.js';
import { lookupTasks } from '../extensions/remembrancer/taskwarrior.js';

vi.mock('../extensions/remembrancer/reviewer.js', () => ({ runReviewer: vi.fn() }));
vi.mock('../extensions/remembrancer/capture-worker.js', async (original) => ({
  ...(await original<typeof import('../extensions/remembrancer/capture-worker.js')>()),
  launchCaptureWorker: vi.fn().mockResolvedValue(123),
}));
vi.mock('../extensions/remembrancer/taskwarrior.js', async (original) => ({
  ...(await original<typeof import('../extensions/remembrancer/taskwarrior.js')>()),
  lookupTasks: vi.fn().mockResolvedValue({ tasks: [], nextOffset: null }),
}));

let dir: string;
let file: string;
let ctx: ExtensionContext;
let db: CheckpointStore;
let handlers: Map<string, (event: object, ctx: ExtensionContext) => unknown>;
let manualTool: ToolDefinition;
let proposalTool: ToolDefinition;
const runner = vi.mocked(runReviewer);
let fixture: ReturnType<typeof captureExtension>;
let config: ReturnType<typeof captureExtension>['settings'];
function message(id: string, parentId: string | null, text = 'Send Maya the comparison') {
  return (
    JSON.stringify({
      type: 'message',
      id,
      parentId,
      timestamp: '2026-11-01T00:00:00.000Z',
      message: { role: 'user', content: text },
    }) + '\n'
  );
}
async function call(input: ReviewerInput, name: string, args: object = {}) {
  const tool = input.tools.find((tool) => tool.name === `remembrancer_${name}`)!;
  return tool.execute(
    'call',
    args,
    undefined,
    undefined,
    {} as Parameters<ToolDefinition['execute']>[4],
  );
}
async function readAll(input: ReviewerInput) {
  let page;
  do {
    const result = await call(input, 'read_evidence');
    const content = result.content[0]!;
    if (content.type !== 'text') throw new Error('Expected text');
    page = JSON.parse(content.text);
  } while (page.hasMore);
  return page;
}
async function empty(input: ReviewerInput) {
  await readAll(input);
  await call(input, 'submit', { proposals: [] });
}
async function capture() {
  const inbox = join(dirname(db.file), 'capture-inbox');
  const accepted = await preserveHandoff({
    id: randomUUID(),
    inbox,
    source: { file, sessionId: 'outgoing' },
    execution: captureExecution(ctx),
  });
  await runCaptureWorker({ database: db.file, inbox });
  return accepted.manifest.id;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(launchCaptureWorker).mockResolvedValue(123);
  fixture = captureExtension(true);
  ({ dir, file, ctx, handlers, settings: config } = fixture);
  db = fixture.db!;
  config({ autoCapture: true });
  runner.mockImplementation(empty);
});
afterEach(async () => {
  await fixture.close(ctx);
});

it('includes pre-opt-in evidence, excludes covered evidence and other enrolled sources, skips unchanged', async () => {
  db.enroll('other', '/must-not-read');
  await capture();
  await capture();
  expect(runner).toHaveBeenCalledOnce();
  expect(db.reviewed().map((item) => item.sessionId)).toEqual(['outgoing']);
  appendFileSync(file, message('later', 'promise', 'Later promise'));
  runner.mockImplementation(async (input) => {
    const page = await readAll(input);
    expect(
      page.groups
        .flatMap((group: { entries: { entryId: string }[] }) => group.entries)
        .map((entry: { entryId: string }) => entry.entryId),
    ).toEqual(['later']);
    await call(input, 'submit', { proposals: [] });
  });
  await capture();
  expect(runner).toHaveBeenCalledTimes(2);
});
it.each([false, true])(
  'saves nonempty proposals atomically and rejects invalid references=%s',
  async (invalid) => {
    runner.mockImplementation(async (input) => {
      const page = await readAll(input);
      const group = page.groups[0];
      const entry = group.entries[0];
      await call(input, 'submit', {
        proposals: [
          {
            change: {
              operation: 'add',
              fields: { description: 'Send comparison' },
              annotations: [],
            },
            expected: null,
            question: null,
            explanation: 'User promise',
            references: [
              {
                sessionId: group.sessionId,
                branchId: group.branchId,
                entryId: entry.entryId,
                editId: entry.editId,
                offset: 0,
                quote: invalid ? 'Invented quote' : 'Send Maya',
              },
            ],
          },
        ],
      });
      expect(db.proposals()).toEqual([]);
      expect(db.reviewed()).toEqual([]);
    });
    await capture();
    expect(db.proposals()).toHaveLength(invalid ? 0 : 1);
    expect(db.reviewed()).toHaveLength(invalid ? 0 : 1);
  },
);
it('rejects malformed saved scope without calling the model', async () => {
  appendFileSync(file, '{broken json\n');
  await capture();
  expect(runner).not.toHaveBeenCalled();
  expect(db.reviewed()).toEqual([]);
  expect(existsSync(db.file + '.capture.log')).toBe(true);
});
it('stages without persisting, then commits empty coverage only after reviewer cleanup', async () => {
  runner.mockImplementation(async (input) => {
    await empty(input);
    expect(db.reviewed()).toEqual([]);
  });
  await capture();
  expect(db.reviewed()).toHaveLength(1);
});
it.each(['unread', 'partial', 'duplicate', 'invalid', 'model error', 'missing submission'])(
  'rejects %s without coverage/proposals',
  async (failure) => {
    if (failure === 'partial')
      appendFileSync(file, message('large', 'promise', 'x'.repeat(60_000)));
    runner.mockImplementation(async (input) => {
      if (failure === 'missing submission') return;
      if (failure === 'partial') await call(input, 'read_evidence');
      else if (failure !== 'unread') await readAll(input);
      await call(input, 'submit', { proposals: failure === 'invalid' ? [{}] : [] });
      if (failure === 'duplicate') await call(input, 'submit', { proposals: [] });
      if (failure === 'model error') throw new Error('context overflow');
    });
    await capture();
    expect(db.reviewed()).toEqual([]);
    expect(db.proposals()).toEqual([]);
    expect(existsSync(db.file + '.capture.log')).toBe(true);
  },
);
it('leaves appends outside the frozen review and closes extraction after submission', async () => {
  runner.mockImplementation(async (input) => {
    await empty(input);
    appendFileSync(file, message('later', 'promise'));
    const closed = await call(input, 'read_evidence');
    expect(closed).toMatchObject({ terminate: true, content: [{ text: 'Review closed.' }] });
  });
  await capture();
  const manual = prepareReview([{ sessionId: 'outgoing', file }], db.reviewed());
  expect(manual.evidence.map((item) => item.entryId)).toEqual(['later']);
});
it('reads frozen context through the capture tool without consuming evidence', async () => {
  appendFileSync(file, message('selected', 'promise', 'selected commitment'));
  runner.mockImplementation(async (input) => {
    const selected = {
      sessionId: 'outgoing',
      branchId: 'selected',
      entryId: 'selected',
      editId: null,
    };
    appendFileSync(file, message('later', 'selected', 'outside frozen scope'));
    const result = await call(input, 'context', { selected, offset: 5 });
    expect(JSON.parse((result.content[0] as { text: string }).text)).toMatchObject({
      selected,
      contextOnly: true,
      groups: [{ entries: [{ entryId: 'promise', offset: 5, text: 'Maya the comparison' }] }],
      nextOffset: null,
    });
    expect(await readAll(input)).toMatchObject({
      groups: [{ entries: [{ entryId: 'promise' }, { entryId: 'selected' }] }],
    });
    await call(input, 'submit', { proposals: [] });
  });
  await capture();
  expect(db.reviewed().map((checkpoint) => checkpoint.entryId)).toEqual(['selected']);
});
it('offers only scoped reads, typed task lookups and submission', async () => {
  vi.mocked(lookupTasks).mockResolvedValue({ tasks: [], nextOffset: null });
  runner.mockImplementation(async (input) => {
    await call(input, 'tasks', { status: 'completed' });
    await call(input, 'proposals');
    await empty(input);
  });
  const id = await capture();
  expect(runner).toHaveBeenCalledOnce();
  const input = runner.mock.calls[0]![0];
  expect(input.tools.map((tool) => tool.name)).toEqual([
    'remembrancer_read_evidence',
    'remembrancer_context',
    'remembrancer_tasks',
    'remembrancer_proposals',
    'remembrancer_submit',
  ]);
  expect(lookupTasks).toHaveBeenCalledWith({ status: 'completed' }, undefined, {
    cwd: dir,
    signal: input.signal,
  });
  expect(input.signal).toBeInstanceOf(AbortSignal);
  expect(vi.mocked(lookupTasks).mock.calls[0]![2]?.signal).toBe(input.signal);
  expect(db.captureJob(id)?.state).toBe('completed');
});
it('reconstructs oversized proposal history through the configured capture tool without read writes', async () => {
  runner.mockImplementation(async (input) => {
    const page = await readAll(input);
    await call(input, 'submit', { proposals: [proposal(page), proposal(page)] });
  });
  await capture();
  let oversized = db.proposals()[0]!;
  for (let edit = 0; edit < 24; edit++)
    oversized = db.editProposal(oversized.id, oversized.revision, {
      change: {
        operation: 'add',
        fields: { description: `${edit}: ${'é😀"\\\n'.repeat(500)}` },
        annotations: [],
      },
      expected: null,
      question: null,
    });
  const saved = db.proposals();
  expect(saved).toHaveLength(2);
  expect(Buffer.byteLength(JSON.stringify(oversized.history))).toBeGreaterThan(51_200);
  appendFileSync(file, message('later', 'promise'));
  runner.mockImplementation(async (input) => {
    const tool = input.tools.find((tool) => tool.name === 'remembrancer_proposals')!;
    expect(tool).toBeDefined();
    const before = { coverage: db.reviewed(), sources: db.sources(), notice: db.proposalNotice() };
    const read = async (args: object) => {
      const result = await tool.execute('read', args, undefined, undefined, ctx);
      const block = result.content[0]!;
      if (block.type !== 'text') throw new Error('Expected JSON text');
      expect(Buffer.byteLength(block.text, 'utf8')).toBeLessThanOrEqual(51_200);
      expect(db.proposals()).toEqual(saved);
      expect({
        coverage: db.reviewed(),
        sources: db.sources(),
        notice: db.proposalNotice(),
      }).toEqual(before);
      return JSON.parse(block.text);
    };
    let page = await read({});
    let restored = '';
    let chunks = 0;
    do {
      expect(page.proposals).toEqual([]);
      expect(page.nextOffset).toBe(1);
      expect(page.proposalChunk).toMatchObject({
        id: oversized.id,
        revision: oversized.revision,
        position: restored.length,
      });
      expect(page.proposalChunk.text.length).toBeGreaterThan(0);
      restored += page.proposalChunk.text;
      expect(++chunks).toBeLessThan(100);
      if (page.nextContinuation === null) break;
      page = await read({ continuation: page.nextContinuation });
    } while (chunks < 100);
    expect(chunks).toBeGreaterThan(1);
    expect(restored).toBe(JSON.stringify(oversized));
    expect(JSON.parse(restored)).toEqual(saved[0]);
    page = await read({ offset: page.nextOffset });
    expect(page).toEqual({ proposals: [saved[1]], nextOffset: 2 });
    expect(await read({ offset: page.nextOffset })).toEqual({ proposals: [], nextOffset: null });
    await empty(input);
  });
  const id = await capture();
  // Worker failures are persisted rather than thrown. Surface the actual callback failure here.
  await runner.mock.results.at(-1)!.value;
  // Successful publication also proves the reads did not change the review generation.
  expect(db.captureJob(id)?.state).toBe('completed');
  expect(db.proposals()).toEqual(saved);
  expect(db.reviewed().map((checkpoint) => checkpoint.entryId)).toEqual(['promise', 'later']);
});

it('reports contention without model calls and cannot release another owner', async () => {
  const other = new CheckpointStore();
  other.claimReview();
  try {
    await capture();
    expect(runner).not.toHaveBeenCalled();
    expect(() => other.claimReview()).toThrow('already open');
  } finally {
    other.close();
  }
});
type Page = {
  groups: {
    sessionId: string;
    branchId: string;
    entries: { entryId: string; editId: string | null; text: string; offset: number }[];
  }[];
};
function proposal(page: Page) {
  const group = page.groups[0]!;
  const entry = group.entries[0]!;
  return {
    change: {
      operation: 'add' as const,
      fields: { description: 'Send comparison' },
      annotations: [],
    },
    expected: null,
    question: null,
    explanation: 'Accepted promise',
    references: [
      {
        sessionId: group.sessionId,
        branchId: group.branchId,
        entryId: entry.entryId,
        editId: entry.editId,
        offset: entry.offset,
        quote: entry.text.slice(0, 9),
      },
    ],
  };
}
async function manual(args: object) {
  const result = await manualTool.execute('manual', args, undefined, undefined, ctx);
  const block = result.content[0]!;
  if (block.type !== 'text') throw new Error('Expected text');
  return JSON.parse(block.text);
}

it('automatic coverage prevents manual replay and manual finish leaves pending proposals unchanged', async () => {
  runner.mockImplementation(async (input) => {
    const page = await readAll(input);
    await call(input, 'submit', { proposals: [proposal(page)] });
  });
  await capture();
  const saved = db.proposals();
  expect(saved).toHaveLength(1);
  config({ autoCapture: false });
  ctx = { ...ctx, mode: 'print', hasUI: false };
  await handlers.get('session_start')!({}, ctx);
  manualTool = fixture.tools.find((tool) => tool.name === 'remembrancer_review')!;
  proposalTool = fixture.tools.find((tool) => tool.name === 'remembrancer_proposals')!;
  let batch = await manual({ action: 'begin' });
  expect(batch.groups).toEqual([]);
  const readSaved = async (args: object) => {
    const result = await proposalTool.execute('proposals', args, undefined, undefined, ctx);
    const content = result.content[0]!;
    if (content.type !== 'text') throw new Error('Expected text');
    return JSON.parse(content.text);
  };
  expect(await readSaved({})).toEqual({ proposals: saved, nextOffset: 1 });
  expect(await readSaved({ offset: 1 })).toEqual({ proposals: [], nextOffset: null });
  expect(await manual({ action: 'finish', batch: batch.batch })).toMatchObject({ finished: true });
  appendFileSync(file, message('later', 'promise', 'A later manual obligation'));
  batch = await manual({ action: 'begin' });
  expect(
    batch.groups
      .flatMap((group: Page['groups'][number]) => group.entries)
      .map((entry: { entryId: string }) => entry.entryId),
  ).toEqual(['later']);
  expect(await manual({ action: 'finish', batch: batch.batch })).toMatchObject({ finished: true });
  expect(db.proposals()).toEqual(saved);
  await handlers.get('session_shutdown')!({ reason: 'quit' }, ctx);
  expect(runner).toHaveBeenCalledOnce();
});

it.each(['empty', 'tool-only', 'covered'])(
  'makes no reviewer call or capture write for %s evidence',
  async (kind) => {
    if (kind !== 'covered')
      writeFileSync(file, JSON.stringify({ type: 'session', id: 'outgoing', cwd: dir }) + '\n');
    if (kind === 'tool-only')
      appendFileSync(
        file,
        JSON.stringify({
          type: 'message',
          id: 'tool',
          parentId: null,
          message: { role: 'toolResult', content: 'not evidence' },
        }) + '\n',
      );
    if (kind === 'covered') {
      const prepared = prepareReview([{ sessionId: 'outgoing', file }], db.reviewed());
      db.claimReview();
      db.finish({
        sources: prepared.successfulSources,
        sourceDefaults: prepared.sourceDefaults,
        checkpoints: prepared.checkpoints,
      });
      db.releaseReview();
    }
    const effects = () => ({
      sources: db.sources(),
      reviewed: db.reviewed(),
      proposals: db.proposals(),
      notice: db.proposalNotice(),
    });
    const before = effects();
    const id = await capture();
    expect(runner).not.toHaveBeenCalled();
    expect(db.captureJob(id)).toMatchObject({ state: 'completed', retryEligible: false });
    expect(effects()).toEqual(before);
    db.claimReview();
    db.releaseReview();
  },
);

it('reads only the outgoing file and preserves settings and other enrolled defaults', async () => {
  const otherFile = join(dir, 'must-not-read.jsonl');
  writeFileSync(otherFile, 'broken archive\n');
  db.enroll('other', otherFile);
  const sources = db.sources();
  const settings = readFileSync(join(dir, 'agent', 'settings.json'), 'utf8');
  await capture();
  expect(runner.mock.calls[0]![0].sessionId).toBe('outgoing');
  expect(db.sources().find((source) => source.sessionId === 'other')).toEqual(sources[0]);
  expect(readFileSync(join(dir, 'agent', 'settings.json'), 'utf8')).toBe(settings);
  expect(db.reviewed().every((tip) => tip.sessionId === 'outgoing')).toBe(true);
});

it('freezes evidence before the reviewer starts, leaving late appends and edits eligible', async () => {
  runner.mockImplementation(async (input) => {
    appendFileSync(
      file,
      JSON.stringify({
        type: 'context_edit',
        id: 'edit',
        parentId: 'promise',
        targetId: 'promise',
        replacement: { content: 'Edited after freeze' },
      }) +
        '\n' +
        message('later', 'edit', 'Late append'),
    );
    const page = await readAll(input);
    expect(
      page.groups
        .flatMap((group: Page['groups'][number]) => group.entries)
        .map((entry: { text: string }) => entry.text),
    ).toEqual(['Send Maya the comparison']);
    await call(input, 'submit', { proposals: [proposal(page)] });
  });
  await capture();
  expect(db.proposals()[0]!.sources[0]!.quote).toBe('Send Maya');
  const next = prepareReview([{ sessionId: 'outgoing', file }], db.reviewed());
  expect(next.evidence.map((item) => item.text)).toEqual(['Edited after freeze', 'Late append']);
});

it('delivers every continuation of long frozen evidence before allowing explicit empty submission', async () => {
  const text = 'promise '.repeat(15_000);
  writeFileSync(
    file,
    JSON.stringify({ type: 'session', id: 'outgoing', cwd: dir }) +
      '\n' +
      message('promise', null, text),
  );
  runner.mockImplementation(async (input) => {
    let restored = '';
    let page;
    let pages = 0;
    do {
      const result = await call(input, 'read_evidence');
      const block = result.content[0]!;
      if (block.type !== 'text') throw new Error('Expected text');
      page = JSON.parse(block.text) as Page & { hasMore: boolean };
      for (const group of page.groups)
        for (const entry of group.entries) {
          expect(entry.offset).toBe(restored.length);
          restored += entry.text;
        }
      pages++;
    } while (page.hasMore);
    expect(pages).toBeGreaterThan(1);
    expect(restored).toBe(text);
    await call(input, 'submit', { proposals: [] });
  });
  await capture();
  expect(db.reviewed()).toHaveLength(1);
});

it.each(['setup', 'tool', 'cleanup', 'storage'])(
  'leaves no data or coverage after %s failure and releases ownership',
  async (phase) => {
    if (phase === 'storage')
      vi.spyOn(CheckpointStore.prototype, 'finishCaptureJob').mockImplementation(() => {
        throw new Error('storage failed');
      });
    runner.mockImplementation(async (input) => {
      if (phase === 'setup') throw new Error('setup failed');
      if (phase === 'tool') {
        await call(input, 'context', {});
        return;
      }
      const page = await readAll(input);
      await call(input, 'submit', { proposals: [proposal(page)] });
      if (phase === 'cleanup') throw new Error('cleanup failed');
    });
    await capture();
    expect(db.proposals()).toEqual([]);
    expect(db.reviewed()).toEqual([]);
    expect(db.sources()).toEqual([]);
    expect(existsSync(db.file + '.capture.log')).toBe(true);
    db.claimReview();
    db.releaseReview();
  },
);

it('allows manual ownership through reviewer cleanup and reprepares after that context changes', async () => {
  const peer = new CheckpointStore();
  let changed = false;
  try {
    runner.mockImplementation(async (input) => {
      await empty(input);
      if (!changed) {
        peer.claimReview();
        peer.releaseReview();
        changed = true;
      }
    });
    await capture();
    expect(runner).toHaveBeenCalledTimes(2);
    expect(db.reviewed()).toHaveLength(1);
    peer.claimReview();
  } finally {
    peer.close();
  }
});

it.each(['capture', 'release', 'close'])(
  'reports safe shutdown %s diagnostics and still closes the database',
  async (phase) => {
    const error = Object.assign(new Error('SECRET provider body and !credential-command'), {
      code: 'EACCES',
      cause: new Error('SECRET nested credentials'),
    });
    await handlers.get('session_start')!({}, ctx);
    const originalClose = CheckpointStore.prototype.close;
    const close = vi.spyOn(CheckpointStore.prototype, 'close');
    if (phase === 'capture') vi.mocked(launchCaptureWorker).mockRejectedValue(error);
    if (phase === 'release')
      vi.spyOn(CheckpointStore.prototype, 'releaseReview').mockImplementationOnce(() => {
        throw error;
      });
    if (phase === 'close') {
      config({ autoCapture: false });
      close.mockImplementationOnce(function (this: CheckpointStore) {
        originalClose.call(this);
        throw error;
      });
    }
    await handlers.get('session_shutdown')!({ reason: 'reload' }, ctx);
    const expectedPhase = {
      capture: 'worker-launch',
      release: 'manual-release',
      close: 'foreground-close',
    }[phase];
    expect(ctx.ui.notify).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining(`Capture ${expectedPhase}: shutdown-failed (EACCES)`),
      'warning',
    );
    const diagnostics = JSON.stringify(vi.mocked(ctx.ui.notify).mock.calls);
    expect(diagnostics).not.toMatch(/SECRET|provider body|credential-command|contention/);
    expect(close).toHaveBeenCalledOnce();
    expect(db.reviewed()).toEqual([]);
    expect(db.proposals()).toEqual([]);
    db.claimReview();
    db.releaseReview();
  },
);

it.each(['SECRET non-Error provider failure', { code: 'ENOSPC', message: 'SECRET command' }])(
  'does not expose arbitrary rejected values in shutdown diagnostics: %j',
  async (failure) => {
    vi.mocked(launchCaptureWorker).mockRejectedValue(failure);
    await handlers.get('session_shutdown')!({ reason: 'reload' }, ctx);
    expect(ctx.ui.notify).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining('Capture worker-launch: shutdown-failed'),
      'warning',
    );
    const diagnostics = JSON.stringify(vi.mocked(ctx.ui.notify).mock.calls);
    expect(diagnostics).not.toMatch(/SECRET|command|contention/);
    if (typeof failure === 'object') expect(diagnostics).toContain('ENOSPC');
  },
);

it('closes the shutdown database even when failure notification throws', async () => {
  await handlers.get('session_start')!({}, ctx);
  const close = vi.spyOn(CheckpointStore.prototype, 'close');
  vi.mocked(launchCaptureWorker).mockRejectedValue(new Error('launch failed'));
  vi.mocked(ctx.ui.notify).mockImplementation(() => {
    throw new Error('notice failed');
  });
  await expect(handlers.get('session_shutdown')!({ reason: 'quit' }, ctx)).rejects.toThrow(
    'notice failed',
  );
  expect(close).toHaveBeenCalledOnce();
  db.claimReview();
  db.releaseReview();
});

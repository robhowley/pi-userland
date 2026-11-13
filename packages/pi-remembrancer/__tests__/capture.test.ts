import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CheckpointStore } from '../extensions/remembrancer/checkpoints.js';
import { prepareReview } from '../extensions/remembrancer/evidence.js';
import { captureOutgoing, CAPTURE_BUDGET_MS } from '../extensions/remembrancer/capture.js';
import remembrancer from '../extensions/remembrancer/index.js';
import { runReviewer, type ReviewerInput } from '../extensions/remembrancer/reviewer.js';
import { lookupTasks } from '../extensions/remembrancer/taskwarrior.js';

vi.mock('../extensions/remembrancer/reviewer.js', () => ({ runReviewer: vi.fn() }));
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
const runner = vi.mocked(runReviewer);
function config(value: object, project = false) {
  writeFileSync(
    join(dir, project ? '.pi' : 'agent', 'settings.json'),
    JSON.stringify({ 'pi-remembrancer': value }),
  );
}
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
  await captureOutgoing(ctx, () => db, Date.now() + CAPTURE_BUDGET_MS);
}

beforeEach(() => {
  vi.clearAllMocks();
  dir = mkdtempSync(join(tmpdir(), 'capture-'));
  mkdirSync(join(dir, 'agent'));
  mkdirSync(join(dir, '.pi'));
  vi.stubEnv('PI_CODING_AGENT_DIR', join(dir, 'agent'));
  vi.stubEnv('XDG_STATE_HOME', dir);
  file = join(dir, 'outgoing.jsonl');
  writeFileSync(
    file,
    JSON.stringify({ type: 'session', id: 'outgoing', cwd: dir }) + '\n' + message('promise', null),
  );
  ctx = {
    cwd: dir,
    mode: 'tui',
    model: { id: 'selected', provider: 'offline' },
    isProjectTrusted: () => true,
    ui: { notify: vi.fn() },
    sessionManager: { getSessionFile: () => file, getSessionId: () => 'outgoing' },
  } as unknown as ExtensionContext;
  db = new CheckpointStore();
  config({ autoCapture: true });
  handlers = new Map();
  remembrancer({
    on: (name: string, handler: (event: object, ctx: ExtensionContext) => unknown) =>
      handlers.set(name, handler),
    registerCommand: vi.fn(),
    registerTool: (tool: ToolDefinition) => {
      manualTool = tool;
    },
  } as unknown as ExtensionAPI);
  runner.mockImplementation(empty);
});
afterEach(() => {
  db.close();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

it.each(['quit', 'reload', 'new', 'resume', 'fork'])(
  'awaits %s capture of outgoing identity/model, never the destination',
  async (reason) => {
    const transcript = readFileSync(file, 'utf8');
    await handlers.get('session_start')!({}, ctx);
    await handlers.get('session_shutdown')!({ reason, targetSessionFile: '/not-the-source' }, ctx);
    expect(runner).toHaveBeenCalledOnce();
    expect(runner.mock.calls[0]![0]).toMatchObject({ model: ctx.model, sessionId: 'outgoing' });
    expect(db.reviewed()).toHaveLength(1);
    expect(readFileSync(file, 'utf8')).toBe(transcript);
  },
);
it.each(['rpc', 'json', 'print', 'headless', 'unknown', undefined])(
  'quietly skips mode %s',
  async (mode) => {
    ctx = { ...ctx, mode } as ExtensionContext;
    await capture();
    expect(runner).not.toHaveBeenCalled();
    expect(ctx.ui.notify).not.toHaveBeenCalled();
  },
);
it('skips unsaved, off and disabled sessions', async () => {
  for (const settings of [{}, { autoCapture: false }, { autoCapture: true, disabled: true }]) {
    config(settings);
    await capture();
  }
  config({ autoCapture: true });
  ctx = { ...ctx, sessionManager: { ...ctx.sessionManager, getSessionFile: () => undefined } };
  await capture();
  expect(runner).not.toHaveBeenCalled();
  expect(db.reviewed()).toEqual([]);
});
it.each([true, false])(
  're-reads opt-in settings at shutdown, startup enabled=%s',
  async (enabled) => {
    config({ autoCapture: enabled, disabled: !enabled });
    await handlers.get('session_start')!({}, ctx);
    config({ autoCapture: !enabled, disabled: enabled });
    await handlers.get('session_shutdown')!({ reason: 'quit' }, ctx);
    expect(runner).toHaveBeenCalledTimes(enabled ? 0 : 1);
  },
);
it.each([true, false])(
  'uses current trusted project settings only when trusted=%s',
  async (trusted) => {
    config({ autoCapture: false });
    config({ autoCapture: true }, true);
    ctx = { ...ctx, isProjectTrusted: () => trusted };
    await capture();
    expect(runner).toHaveBeenCalledTimes(trusted ? 1 : 0);
  },
);
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
it('manual completion excludes covered evidence from automatic capture', async () => {
  const manual = prepareReview([{ sessionId: 'outgoing', file }], db.reviewed());
  db.claimReview();
  db.finish({
    sources: manual.successfulSources,
    sourceDefaults: manual.sourceDefaults,
    checkpoints: manual.checkpoints,
  });
  db.releaseReview();
  await capture();
  expect(runner).not.toHaveBeenCalled();
});
it('rejects malformed saved scope without calling the model', async () => {
  appendFileSync(file, '{broken json\n');
  await capture();
  expect(runner).not.toHaveBeenCalled();
  expect(db.reviewed()).toEqual([]);
  expect(ctx.ui.notify).toHaveBeenCalled();
});
it('stages without persisting, then commits empty coverage only after reviewer cleanup', async () => {
  runner.mockImplementation(async (input) => {
    await empty(input);
    expect(db.reviewed()).toEqual([]);
  });
  await capture();
  expect(db.reviewed()).toHaveLength(1);
});
it.each(['unread', 'partial', 'duplicate', 'invalid', 'model error', 'missing submission', 'late'])(
  'rejects %s without coverage/proposals',
  async (failure) => {
    if (failure === 'partial')
      appendFileSync(file, message('large', 'promise', 'x'.repeat(60_000)));
    runner.mockImplementation(async (input) => {
      if (failure === 'missing submission') return;
      if (failure === 'partial') await call(input, 'read_evidence');
      else if (failure !== 'unread') await readAll(input);
      if (failure === 'late') vi.spyOn(Date, 'now').mockReturnValue(Date.now() + CAPTURE_BUDGET_MS);
      await call(input, 'submit', { proposals: failure === 'invalid' ? [{}] : [] });
      if (failure === 'duplicate') {
        try {
          await call(input, 'submit', { proposals: [] });
        } catch {
          /* SDK turns tool errors into results */
        }
      }
      if (failure === 'model error') throw new Error('context overflow');
    });
    await capture();
    expect(db.reviewed()).toEqual([]);
    expect(db.proposals()).toEqual([]);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining('outgoing'), 'warning');
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
  runner.mockImplementation(async (input) => {
    expect(input.tools.map((tool) => tool.name)).toEqual([
      'remembrancer_read_evidence',
      'remembrancer_context',
      'remembrancer_tasks',
      'remembrancer_proposals',
      'remembrancer_submit',
    ]);
    await call(input, 'tasks', { status: 'completed' });
    expect(lookupTasks).toHaveBeenCalledWith({ status: 'completed' });
    await call(input, 'proposals');
    await empty(input);
  });
  await capture();
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
it('cancels at budget and waits for cleanup beyond it, rejecting late successful output', async () => {
  vi.useFakeTimers();
  let cleanup!: () => void;
  let signal!: AbortSignal;
  runner.mockImplementation(async (input) => {
    signal = input.signal!;
    await empty(input);
    await new Promise<void>((resolve) => {
      cleanup = resolve;
    });
  });
  let settled = false;
  const running = capture().then(() => {
    settled = true;
  });
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(CAPTURE_BUDGET_MS);
  expect(signal.aborted).toBe(true);
  expect(settled).toBe(false);
  expect(db.reviewed()).toEqual([]);
  cleanup();
  await running;
  expect(db.reviewed()).toEqual([]);
  expect(db.proposals()).toEqual([]);
});
it('holds process ownership past the deadline until cleanup completes', async () => {
  vi.useFakeTimers();
  const other = new CheckpointStore();
  runner.mockImplementation(async (input) => {
    await empty(input);
    await vi.advanceTimersByTimeAsync(CAPTURE_BUDGET_MS);
    expect(() => other.claimReview()).toThrow('already open');
    other.enroll('other', '/enrollment-remains-possible');
  });
  try {
    await capture();
    other.claimReview();
    expect(db.reviewed()).toEqual([]);
  } finally {
    other.close();
  }
});

it('shutdown closes its database only after awaited reviewer cleanup', async () => {
  vi.useFakeTimers();
  const close = vi.spyOn(CheckpointStore.prototype, 'close');
  let cleanup!: () => void;
  runner.mockImplementation(async (input) => {
    await empty(input);
    await new Promise<void>((resolve) => {
      cleanup = resolve;
    });
  });
  const running = handlers.get('session_shutdown')!({ reason: 'quit' }, ctx);
  await vi.advanceTimersByTimeAsync(CAPTURE_BUDGET_MS);
  expect(close).not.toHaveBeenCalled();
  cleanup();
  await running;
  expect(close).toHaveBeenCalledOnce();
  expect(db.reviewed()).toEqual([]);
});

it('releases ownership even when failure notification throws', async () => {
  runner.mockRejectedValue(new Error('failure'));
  vi.mocked(ctx.ui.notify).mockImplementation(() => {
    throw new Error('notice');
  });
  await expect(capture()).rejects.toThrow('notice');
  db.claimReview();
  db.releaseReview();
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

it('abandons an open manual batch before opt-in capture without saving its coverage', async () => {
  await handlers.get('session_start')!({}, ctx);
  const batch = await manual({ action: 'begin' });
  expect(batch.groups).not.toHaveLength(0);
  expect(() => db.claimReview()).toThrow('already open');
  runner.mockImplementation(async (input) => {
    expect(db.reviewed()).toEqual([]);
    const page = await readAll(input);
    expect(page.groups[0].entries[0].text).toBe('Send Maya the comparison');
    await call(input, 'submit', { proposals: [] });
  });
  await handlers.get('session_shutdown')!({ reason: 'reload' }, ctx);
  expect(runner).toHaveBeenCalledOnce();
  expect(db.reviewed()).toHaveLength(1);
  db.claimReview();
  db.releaseReview();
});

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
  let batch = await manual({ action: 'begin' });
  expect(batch.groups).toEqual([]);
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
      const prepared = prepareReview([{ sessionId: 'outgoing', file }], []);
      db.enroll('outgoing', file);
      db.finish(prepared.tips);
    }
    const before = { sources: db.sources(), reviewed: db.reviewed() };
    const finish = vi.spyOn(db, 'finishCapture');
    await capture();
    expect(runner).not.toHaveBeenCalled();
    expect(finish).not.toHaveBeenCalled();
    expect({ sources: db.sources(), reviewed: db.reviewed() }).toEqual(before);
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
  const prepare = vi.spyOn(db, 'prepareCapture');
  await capture();
  expect(prepare).toHaveBeenCalledExactlyOnceWith({ sessionId: 'outgoing', file });
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
      vi.spyOn(db, 'finishCapture').mockImplementation(() => {
        throw new Error('storage failed');
      });
    runner.mockImplementation(async (input) => {
      if (phase === 'setup') throw new Error('setup failed');
      if (phase === 'tool') {
        try {
          await call(input, 'context', {});
        } catch {
          /* SDK reports tool failure. */
        }
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
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining('outgoing'), 'warning');
    db.claimReview();
    db.releaseReview();
  },
);

it('holds the lock through cleanup and commit, then releases it', async () => {
  const peer = new CheckpointStore();
  const finish = db.finishCapture.bind(db);
  vi.spyOn(db, 'finishCapture').mockImplementation((...args) => {
    expect(() => peer.claimReview()).toThrow('already open');
    return finish(...args);
  });
  try {
    runner.mockImplementation(async (input) => {
      await empty(input);
      expect(() => peer.claimReview()).toThrow('already open');
    });
    await capture();
    expect(db.reviewed()).toHaveLength(1);
    peer.claimReview();
  } finally {
    peer.close();
  }
});

it('counts manual abandonment and preparation time against the shutdown-entry budget', async () => {
  vi.useFakeTimers();
  await handlers.get('session_start')!({}, ctx);
  await manual({ action: 'begin' });
  const release = CheckpointStore.prototype.releaseReview;
  let first = true;
  vi.spyOn(CheckpointStore.prototype, 'releaseReview').mockImplementation(function (
    this: CheckpointStore,
  ) {
    if (first) {
      first = false;
      vi.setSystemTime(Date.now() + CAPTURE_BUDGET_MS);
    }
    return release.call(this);
  });
  await handlers.get('session_shutdown')!({ reason: 'quit' }, ctx);
  expect(runner).not.toHaveBeenCalled();
  expect(db.reviewed()).toEqual([]);
  expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining('timed out'), 'warning');
});

it.each(['capture', 'release', 'close'])(
  'reports the full stack for shutdown %s failures and still closes the database',
  async (phase) => {
    const error = new Error(`${'Failure detail '.repeat(30)}\nAdditional diagnostics`);
    await handlers.get('session_start')!({}, ctx);
    const originalClose = CheckpointStore.prototype.close;
    const close = vi.spyOn(CheckpointStore.prototype, 'close');
    if (phase === 'capture') runner.mockRejectedValue(error);
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
    expect(ctx.ui.notify).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining(error.stack!),
      'warning',
    );
    expect(close).toHaveBeenCalledOnce();
    expect(db.reviewed()).toEqual([]);
    expect(db.proposals()).toEqual([]);
    db.claimReview();
    db.releaseReview();
  },
);

it('reports non-Error capture failures without truncating them', async () => {
  const failure = `${'Failure detail '.repeat(30)}\nAdditional diagnostics`;
  runner.mockRejectedValue(failure);
  await handlers.get('session_shutdown')!({ reason: 'reload' }, ctx);
  expect(ctx.ui.notify).toHaveBeenCalledExactlyOnceWith(
    expect.stringContaining(failure),
    'warning',
  );
});

it('closes the shutdown database even when failure notification throws', async () => {
  const close = vi.spyOn(CheckpointStore.prototype, 'close');
  runner.mockRejectedValue(new Error('cleanup failed'));
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

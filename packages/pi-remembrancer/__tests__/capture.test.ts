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
import { beginSourceReview } from '../extensions/remembrancer/review.js';
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
    registerTool: vi.fn(),
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
it.each(['rpc', 'json', 'print', undefined])('quietly skips mode %s', async (mode) => {
  ctx = { ...ctx, mode } as ExtensionContext;
  await capture();
  expect(runner).not.toHaveBeenCalled();
  expect(ctx.ui.notify).not.toHaveBeenCalled();
});
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
  const manual = beginSourceReview(db, [{ sessionId: 'outgoing', file }]);
  manual.page();
  manual.finish([]);
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
      appendFileSync(file, message('large', 'promise', 'x'.repeat(30_000)));
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
  const manual = beginSourceReview(db, [{ sessionId: 'outgoing', file }]);
  expect(manual.batch.evidence.map((item) => item.entryId)).toEqual(['later']);
  manual.cancel();
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
  const token = other.claimReview();
  try {
    await capture();
    expect(runner).not.toHaveBeenCalled();
    other.assertReview(token);
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
it('does not save or release a successor lease after cleanup passes the deadline', async () => {
  vi.useFakeTimers();
  const other = new CheckpointStore();
  let successor: string | undefined;
  runner.mockImplementation(async (input) => {
    await empty(input);
    await vi.advanceTimersByTimeAsync(CAPTURE_BUDGET_MS);
    successor = other.claimReview();
  });
  try {
    await capture();
    other.assertReview(successor!);
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

it('releases the lease even when failure notification throws', async () => {
  runner.mockRejectedValue(new Error('failure'));
  vi.mocked(ctx.ui.notify).mockImplementation(() => {
    throw new Error('notice');
  });
  await expect(capture()).rejects.toThrow('notice');
  const token = db.claimReview();
  db.releaseReview(token);
});

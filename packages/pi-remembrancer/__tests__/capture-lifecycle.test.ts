import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import remembrancer, {
  CAPTURE_RECOVERY_MS,
  CAPTURE_TICK_MS,
} from '../extensions/remembrancer/index.js';
import { CheckpointStore, defaultCheckpointFile } from '../extensions/remembrancer/checkpoints.js';
import {
  launchCaptureWorker,
  runCaptureWorker,
} from '../extensions/remembrancer/capture-worker.js';
import * as notices from '../extensions/remembrancer/capture-notices.js';
import { captureExecution } from '../extensions/remembrancer/config.js';

vi.mock('../extensions/remembrancer/capture-worker.js', async (original) => ({
  ...(await original<typeof import('../extensions/remembrancer/capture-worker.js')>()),
  launchCaptureWorker: vi.fn().mockResolvedValue(123),
}));
let dir: string;
let ctx: ExtensionContext;
let handlers: Map<string, (event: object, ctx: ExtensionContext) => unknown>;
let tools: ToolDefinition[];
let send: ReturnType<typeof vi.fn>;
const launch = vi.mocked(launchCaptureWorker);
const settings = (value: object, project = false) =>
  writeFileSync(
    join(dir, project ? '.pi' : 'agent', 'settings.json'),
    JSON.stringify({ 'pi-remembrancer': value }),
  );
const inbox = () => join(dirname(defaultCheckpointFile()), 'capture-inbox');
const ready = () => readdirSync(inbox()).filter((name) => name.endsWith('.ready.json'));
function bind() {
  handlers = new Map();
  tools = [];
  send = vi.fn();
  remembrancer({
    on: (name: string, handler: (event: object, ctx: ExtensionContext) => unknown) =>
      handlers.set(name, handler),
    registerCommand: vi.fn(),
    registerTool: (tool: ToolDefinition) => tools.push(tool),
    sendUserMessage: send,
  } as unknown as ExtensionAPI);
}
async function start() {
  await handlers.get('session_start')!({}, ctx);
}
async function stop(reason = 'quit') {
  await handlers.get('session_shutdown')!({ reason, targetSessionFile: '/destination' }, ctx);
}
beforeEach(() => {
  vi.clearAllMocks();
  launch.mockResolvedValue(123);
  dir = mkdtempSync(join(tmpdir(), 'capture-lifecycle-'));
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
  ctx = {
    cwd: dir,
    mode: 'tui',
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
    ui: { notify: vi.fn() },
    sessionManager: { getSessionFile: () => file, getSessionId: () => 'outgoing' },
  } as unknown as ExtensionContext;
  bind();
});
afterEach(async () => {
  settings({ autoCapture: false });
  await stop();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

it.each(['quit', 'reload', 'new', 'resume', 'fork'])(
  'durably admits the outgoing identity/model/trust on %s without awaiting review or cleanup',
  async (reason) => {
    settings({ autoCapture: true });
    await start();
    const before = readFileSync(ctx.sessionManager.getSessionFile()!, 'utf8');
    await stop(reason);
    const manifest = JSON.parse(readFileSync(join(inbox(), ready()[0]!), 'utf8'));
    expect(manifest.source).toMatchObject({
      file: ctx.sessionManager.getSessionFile(),
      sessionId: 'outgoing',
      bytes: Buffer.byteLength(before),
    });
    expect(readFileSync(manifest.snapshot, 'utf8')).toBe(before);
    expect(manifest.execution).toEqual(captureExecution(ctx));
    expect(launch).toHaveBeenCalledWith(defaultCheckpointFile(), inbox(), manifest.execution.host);
    const db = new CheckpointStore();
    expect(db.reviewed()).toEqual([]);
    db.close();
    expect(send).not.toHaveBeenCalled();
  },
);
it.each(['rpc', 'print', 'json', undefined])('does not admit non-TUI mode %s', async (mode) => {
  settings({ autoCapture: true });
  ctx = { ...ctx, mode } as ExtensionContext;
  await stop();
  expect(launch).not.toHaveBeenCalled();
});
it.each([{}, { autoCapture: false }, { autoCapture: true, disabled: true }])(
  'excludes new jobs for settings %j',
  async (value) => {
    settings(value);
    await stop();
    expect(launch).not.toHaveBeenCalled();
  },
);
it('excludes unsaved sessions', async () => {
  settings({ autoCapture: true });
  ctx = { ...ctx, sessionManager: { ...ctx.sessionManager, getSessionFile: () => undefined } };
  await stop();
  expect(launch).not.toHaveBeenCalled();
});
it.each([true, false])(
  'uses outgoing project override only with context trust=%s, never process cwd',
  async (trusted) => {
    settings({ autoCapture: false });
    settings({ autoCapture: true }, true);
    ctx = { ...ctx, isProjectTrusted: () => trusted };
    await stop('resume');
    expect(launch).toHaveBeenCalledTimes(trusted ? 1 : 0);
    if (trusted) {
      const manifest = JSON.parse(readFileSync(join(inbox(), ready()[0]!), 'utf8'));
      expect(manifest.execution.cwd).toBe(dir);
      expect(manifest.execution.runtime.projectTrusted).toBe(true);
      expect(manifest.execution.runtime.thinkingLevel).toBe('high');
    }
  },
);
it('captures current outgoing model/thinking and opt-in changes rather than startup values', async () => {
  settings({ autoCapture: false });
  await start();
  settings({ autoCapture: true });
  ctx = {
    ...ctx,
    model: { ...ctx.model!, id: 'changed-at-shutdown' },
    thinkingLevel: 'low',
    isProjectTrusted: () => false,
  };
  await stop('fork');
  const manifest = JSON.parse(readFileSync(join(inbox(), ready()[0]!), 'utf8'));
  expect(manifest.execution.runtime.model.id).toBe('changed-at-shutdown');
  expect(manifest.execution.runtime.thinkingLevel).toBe('low');
  expect(manifest.execution.runtime.projectTrusted).toBe(false);
  expect(existsSync(join(dir, 'agent', 'trust.json'))).toBe(false);
});

it('re-reads admission settings after disabled startup, without needing a foreground database', async () => {
  settings({ disabled: true });
  await start();
  settings({ autoCapture: true });
  await stop();
  expect(ready()).toHaveLength(1);
  await runCaptureWorker({
    database: defaultCheckpointFile(),
    inbox: inbox(),
    review: async (current) => {
      while ((current.page() as { hasMore: boolean }).hasMore) {
        /* consume */
      }
      return [];
    },
  });
  const db = new CheckpointStore();
  expect(db.reviewed()).toHaveLength(1);
  db.close();
});
it('abandons manual ownership and closes the foreground store before detached review', async () => {
  settings({ autoCapture: true });
  await start();
  const review = tools.find((tool) => tool.name === 'remembrancer_review')!;
  await review.execute(
    'begin',
    { action: 'begin' },
    undefined,
    undefined,
    ctx as Parameters<ToolDefinition['execute']>[4],
  );
  const db = new CheckpointStore();
  expect(() => db.claimReview()).toThrow('already open');
  await stop('reload');
  db.claimReview();
  expect(db.reviewed()).toEqual([]);
  db.close();
});

it('publishes accepted running proposals after capture is disabled, and the open capture-off TUI notices them', async () => {
  settings({ autoCapture: true });
  await stop();
  settings({ autoCapture: false });
  bind();
  vi.useFakeTimers();
  await start();
  // Let the startup wake settle before running this deterministic reviewer.
  await vi.waitFor(() => expect(launch).toHaveBeenCalledTimes(2));
  let finish!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((r) => {
    entered = r;
  });
  const running = runCaptureWorker({
    database: defaultCheckpointFile(),
    inbox: inbox(),
    review: async (current, _store, input) => {
      expect(input.cwd).toBe(dir);
      expect(input.model).toEqual(ctx.model);
      expect(input.thinkingLevel).toBe('high');
      while ((current.page() as { hasMore: boolean }).hasMore) {
        /* consume */
      }
      entered();
      await new Promise<void>((r) => {
        finish = r;
      });
      return [
        {
          change: { operation: 'add', fields: { description: 'Send comparison' }, annotations: [] },
          expected: null,
          question: null,
          explanation: 'Promise',
          references: [
            {
              sessionId: 'outgoing',
              branchId: 'promise',
              entryId: 'promise',
              editId: null,
              offset: 0,
              quote: 'Send Maya',
            },
          ],
        },
      ];
    },
  });
  await started;
  settings({ disabled: true, autoCapture: false });
  finish();
  await running;
  const db = new CheckpointStore();
  expect(db.proposals()).toHaveLength(1);
  expect(db.proposalNotice()).toEqual({ generation: 1, pending: 1 });
  db.close();
  await vi.advanceTimersByTimeAsync(CAPTURE_TICK_MS);
  await vi.waitFor(() =>
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      '1 task proposals · /remembrancer proposals',
      'info',
    ),
  );
  expect(send).not.toHaveBeenCalled();
});

// Tick tests exercise the actual registered lifecycle, not a second scheduler.
it('recovers failed launches and interrupted accepted work while capture remains off and TUI stays open', async () => {
  settings({ autoCapture: true });
  launch.mockRejectedValueOnce(Error('failed spawn'));
  await stop();
  expect(ready()).toHaveLength(1);
  settings({ autoCapture: false });
  bind();
  vi.useFakeTimers();
  launch.mockRejectedValueOnce(Error('failed recovery spawn'));
  launch.mockImplementation(async (database, inbox) => {
    await runCaptureWorker({
      database,
      inbox,
      review: async (current) => {
        while ((current.page() as { hasMore: boolean }).hasMore) {
          /* consume */
        }
        return [];
      },
    });
    return 123;
  });
  await start();
  await vi.waitFor(() => expect(launch).toHaveBeenCalledTimes(2));
  expect(ready()).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(CAPTURE_RECOVERY_MS);
  await vi.waitFor(() => {
    const db = new CheckpointStore();
    try {
      expect(db.reviewed()).toHaveLength(1);
    } finally {
      db.close();
    }
  });
  expect(ready()).toHaveLength(0);
  expect(send).not.toHaveBeenCalled();
});
it('coalesces generations (including same-count edits), rate-bounds wakes, and preserves capture-off startup access', async () => {
  vi.useFakeTimers();
  settings({ autoCapture: false });
  const read = vi
    .spyOn(notices, 'readProposalNotice')
    .mockResolvedValue({ generation: 0, pending: 0 });
  await start();
  await vi.waitFor(() => expect(launch).toHaveBeenCalledTimes(1));
  launch.mockClear();
  read.mockResolvedValue({ generation: 2, pending: 1 });
  await vi.advanceTimersByTimeAsync(CAPTURE_TICK_MS * 3);
  expect(ctx.ui.notify).toHaveBeenCalledTimes(1);
  read.mockResolvedValue({ generation: 3, pending: 1 });
  await vi.advanceTimersByTimeAsync(CAPTURE_TICK_MS);
  expect(ctx.ui.notify).toHaveBeenCalledTimes(2);
  expect(tools.map((tool) => tool.name)).toContain('remembrancer_proposals');
  expect(launch).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(CAPTURE_RECOVERY_MS);
  await vi.waitFor(() => expect(launch).toHaveBeenCalledTimes(1));
  expect(send).not.toHaveBeenCalled();
});
it('does not overlap slow ticks and ignores an in-flight notice after shutdown/reload', async () => {
  vi.useFakeTimers();
  settings({ autoCapture: false });
  let resolve!: (value: notices.ProposalNotice) => void;
  const read = vi.spyOn(notices, 'readProposalNotice').mockImplementation(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  await start();
  await vi.advanceTimersByTimeAsync(CAPTURE_RECOVERY_MS * 3);
  expect(read).toHaveBeenCalledTimes(1);
  await stop('reload');
  resolve({ generation: 7, pending: 3 });
  await vi.advanceTimersByTimeAsync(CAPTURE_RECOVERY_MS * 3);
  expect(ctx.ui.notify).not.toHaveBeenCalled();
  expect(launch).not.toHaveBeenCalled();
  expect(read).toHaveBeenCalledTimes(1);
});
it('ignores an in-flight failed launch and schedules nothing after shutdown', async () => {
  vi.useFakeTimers();
  settings({ autoCapture: false });
  let reject!: (error: Error) => void;
  launch.mockImplementation(
    () =>
      new Promise((_resolve, r) => {
        reject = r;
      }),
  );
  await start();
  await vi.waitFor(() => expect(launch).toHaveBeenCalledTimes(1));
  await stop();
  reject(Error('late launch failure'));
  await vi.advanceTimersByTimeAsync(CAPTURE_RECOVERY_MS * 3);
  expect(launch).toHaveBeenCalledTimes(1);
  expect(ctx.ui.notify).not.toHaveBeenCalled();
});

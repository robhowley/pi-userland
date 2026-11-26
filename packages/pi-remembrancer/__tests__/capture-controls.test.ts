import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { preserveHandoff } from '../extensions/remembrancer/capture-handoff.js';
import { captureExecution } from '../extensions/remembrancer/config.js';
import { CheckpointStore } from '../extensions/remembrancer/checkpoints.js';
import { launchCaptureWorker } from '../extensions/remembrancer/capture-worker.js';
import {
  parseRemembrancerCommandArgs,
  getRemembrancerArgumentCompletions,
} from '../extensions/remembrancer/index.js';
import { captureExtension } from './fixtures/capture-extension.js';

vi.mock('../extensions/remembrancer/capture-worker.js', () => ({
  launchCaptureWorker: vi.fn().mockResolvedValue(123),
}));
let fixture: ReturnType<typeof captureExtension>;
const launch = vi.mocked(launchCaptureWorker);
const command = (args: string) =>
  fixture.commands.get('remembrancer')!.handler(args, { ...fixture.ctx, isIdle: () => true });
const inbox = () => join(dirname(fixture.db!.file), 'capture-inbox');
const ready = () =>
  existsSync(inbox()) ? readdirSync(inbox()).filter((name) => name.endsWith('.ready.json')) : [];

beforeEach(() => {
  vi.clearAllMocks();
  launch.mockResolvedValue(123);
  fixture = captureExtension(true);
  fixture.settings({ disabled: true, autoCapture: false });
});
afterEach(async () => fixture.close());

async function admit() {
  const accepted = await preserveHandoff({
    id: randomUUID(),
    inbox: join(dirname(fixture.db!.file), 'capture-inbox'),
    source: { file: fixture.file, sessionId: 'outgoing' },
    execution: captureExecution(fixture.ctx),
  });
  const owner = fixture.db!.claimCaptureWorker();
  try {
    fixture.db!.importCaptureJob(owner, accepted.manifest);
  } finally {
    owner.release();
  }
  return accepted.manifest.id;
}

async function fail(retryEligible = false) {
  const id = await admit();
  const db = fixture.db!;
  const owner = db.claimCaptureWorker();
  try {
    const attempt = db.claimCaptureAttempt(owner, id, 1_000)!;
    expect(attempt).toBeDefined();
    db.failCaptureJob(owner, attempt, 'Review rejected: invalid input', retryEligible, 1_000);
  } finally {
    owner.release();
  }
  return id;
}

it('parses only exact capture commands and completes actions, not job prefixes', () => {
  for (const action of ['now', 'status', 'pause', 'resume']) {
    expect(parseRemembrancerCommandArgs(`capture ${action}`)).toEqual({
      ok: true,
      mode: 'capture',
      action,
    });
  }
  expect(parseRemembrancerCommandArgs('capture retry exact-id')).toEqual({
    ok: true,
    mode: 'capture',
    action: 'retry',
    jobId: 'exact-id',
  });
  for (const args of [
    'capture',
    'capture now extra',
    'capture status extra',
    'capture pause extra',
    'capture resume extra',
    'capture retry',
    'capture retry one two',
    'capture retry-all',
  ]) {
    expect(parseRemembrancerCommandArgs(args).ok).toBe(false);
  }
  expect(getRemembrancerArgumentCompletions('capture ')).toEqual([
    { value: 'capture now', label: 'now' },
    { value: 'capture status', label: 'status' },
    { value: 'capture pause', label: 'pause' },
    { value: 'capture resume', label: 'resume' },
    { value: 'capture retry ', label: 'retry' },
  ]);
  expect(getRemembrancerArgumentCompletions('capture re')).toHaveLength(2);
  expect(getRemembrancerArgumentCompletions('capture retry ')).toBeNull();
});

it('capture now preserves the current session before waking the worker without a model turn', async () => {
  fixture.settings({ autoCapture: true });
  fixture.db!.setCapturePaused(true);
  const before = readFileSync(fixture.file, 'utf8');
  launch.mockImplementationOnce(async (database, acceptedInbox, host) => {
    expect(database).toBe(fixture.db!.file);
    expect(acceptedInbox).toBe(inbox());
    expect(ready()).toHaveLength(1);
    const manifest = JSON.parse(readFileSync(join(inbox(), ready()[0]!), 'utf8'));
    expect(manifest.source).toMatchObject({ file: fixture.file, sessionId: 'outgoing' });
    expect(manifest.execution).toEqual(captureExecution(fixture.ctx));
    expect(host).toEqual(manifest.execution.host);
    writeFileSync(fixture.file, before + '\n');
    expect(readFileSync(manifest.snapshot, 'utf8')).toBe(before);
    return 123;
  });
  await command('capture now');
  expect(launch).toHaveBeenCalledOnce();
  const manifest = JSON.parse(readFileSync(join(inbox(), ready()[0]!), 'utf8'));
  expect(fixture.ctx.ui.notify).toHaveBeenCalledWith(
    expect.stringContaining(
      `Capture accepted: ${manifest.id}. Worker wake requested; review may wait.`,
    ),
    'info',
  );
  expect(fixture.ctx.ui.notify).toHaveBeenCalledWith(
    expect.stringContaining('/remembrancer capture status and /remembrancer proposals'),
    'info',
  );
  expect(fixture.db!.captureStatus()).toEqual({ paused: true, jobs: [] });
  expect(fixture.send).not.toHaveBeenCalled();
});

it.each([
  ['print', 'interactive Pi terminal'],
  ['json', 'interactive Pi terminal'],
  ['rpc', 'interactive Pi terminal'],
  ['no-ui', 'interactive Pi terminal'],
  ['busy', 'Pi is busy'],
  ['unsaved', 'saved Pi session'],
  ['disabled', 'autoCapture true'],
  ['not-authorized', 'autoCapture true'],
  ['no-model', 'requires the outgoing model'],
  ['missing-transcript', 'preservation-failed'],
])('capture now refuses %s without queuing or waking', async (scenario, message) => {
  fixture.settings({ autoCapture: true, disabled: scenario === 'disabled' });
  if (scenario === 'not-authorized') fixture.settings({ autoCapture: false });
  if (scenario === 'missing-transcript') unlinkSync(fixture.file);
  const ctx = {
    ...fixture.ctx,
    isIdle: () => scenario !== 'busy',
    ...(scenario === 'print' || scenario === 'json' || scenario === 'rpc'
      ? { mode: scenario }
      : {}),
    ...(scenario === 'no-ui' ? { hasUI: false } : {}),
    ...(scenario === 'no-model' ? { model: undefined } : {}),
    ...(scenario === 'unsaved'
      ? { sessionManager: { ...fixture.ctx.sessionManager, getSessionFile: () => undefined } }
      : {}),
  } as typeof fixture.ctx;
  await fixture.commands.get('remembrancer')!.handler('capture now', ctx);
  expect(ready()).toEqual([]);
  expect(launch).not.toHaveBeenCalled();
  expect(fixture.db!.captureStatus().jobs).toEqual([]);
  expect(fixture.ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining(message), 'error');
  expect(fixture.send).not.toHaveBeenCalled();
});

it('capture now keeps the accepted job recoverable when launch fails', async () => {
  fixture.settings({ autoCapture: true });
  launch.mockRejectedValueOnce(new Error('offline launcher'));
  await command('capture now');
  expect(ready()).toHaveLength(1);
  const manifest = JSON.parse(readFileSync(join(inbox(), ready()[0]!), 'utf8'));
  expect(readFileSync(manifest.snapshot, 'utf8')).toBe(readFileSync(fixture.file, 'utf8'));
  expect(fixture.ctx.ui.notify).toHaveBeenCalledWith(
    expect.stringContaining('state saved; worker launch failed'),
    'warning',
  );
  expect(fixture.ctx.ui.notify).toHaveBeenCalledWith(
    expect.stringContaining(`Capture accepted: ${manifest.id}`),
    'info',
  );
  expect(vi.mocked(fixture.ctx.ui.notify).mock.calls.some(([, level]) => level === 'error')).toBe(
    false,
  );
});

it('status, pause and resume remain available while disabled without a model turn', async () => {
  await command('capture pause');
  expect(fixture.db!.captureStatus().paused).toBe(true);
  await command('capture status');
  expect(fixture.ctx.ui.notify).toHaveBeenCalledWith(
    'Capture: paused\n\nNo unresolved jobs.',
    'info',
  );
  expect(launch).not.toHaveBeenCalled();
  await command('capture resume');
  expect(fixture.db!.captureStatus().paused).toBe(false);
  expect(launch).toHaveBeenCalledOnce();
  expect(fixture.send).not.toHaveBeenCalled();
  expect(fixture.tools).toEqual([]);
});

it('status shows current allowance, stopped diagnostic and actual predecessor IDs', async () => {
  const stopped = await fail();
  const blocked = await admit();
  await command('capture status');
  const message = vi.mocked(fixture.ctx.ui.notify).mock.calls.at(-1)![0];
  expect(message).toContain(stopped);
  expect(message).toContain(blocked);
  expect(message).toContain(
    'Current allowance: 1/2 attempts used, 1 remaining (not lifetime history)',
  );
  expect(message).toContain('Stopped reason: Review rejected: invalid input');
  expect(message).toContain(`Blocked by predecessor: ${stopped}`);
  expect(message).toContain('Next attempt due: none');
  expect(launch).not.toHaveBeenCalled();
});

it('status displays persisted retry due time without launching work', async () => {
  await fail(true);
  await command('capture status');
  expect(fixture.ctx.ui.notify).toHaveBeenCalledWith(
    expect.stringContaining('Next attempt due: 1970-01-01T00:01:01.000Z'),
    'info',
  );
  expect(launch).not.toHaveBeenCalled();
});

it('confirmed exact retry passes the displayed revision and preserves pause and predecessors', async () => {
  const predecessor = await fail();
  const id = await admit();
  await command('capture pause');
  const before = fixture.db!.captureJob(predecessor)!;
  const retry = vi.spyOn(CheckpointStore.prototype, 'retryCaptureJob');
  vi.mocked(fixture.ctx.ui.confirm).mockResolvedValue(true);
  await command(`capture retry ${predecessor}`);
  expect(fixture.ctx.ui.confirm).toHaveBeenCalledWith(
    'Retry capture job?',
    expect.stringContaining('Stopped reason: Review rejected: invalid input'),
  );
  const prompt = vi.mocked(fixture.ctx.ui.confirm).mock.calls[0]![1];
  expect(prompt).toContain('Current allowance: 1/2 attempts used, 1 remaining');
  expect(prompt).toContain('2 fresh whole-review attempts');
  expect(prompt).toContain('is paused and stays paused');
  expect(retry).toHaveBeenCalledExactlyOnceWith(predecessor, before.revision);
  expect(fixture.db!.captureJob(predecessor)).toMatchObject({
    attemptCount: 0,
    revision: before.revision + 1,
    nextAttemptAt: null,
  });
  expect(fixture.db!.captureStatus()).toMatchObject({
    paused: true,
    jobs: expect.arrayContaining([
      expect.objectContaining({
        manifest: expect.objectContaining({ id }),
        blockedBy: predecessor,
      }),
    ]),
  });
  expect(launch).toHaveBeenCalledOnce();
  await command(`capture retry ${predecessor}`);
  expect(fixture.ctx.ui.confirm).toHaveBeenCalledOnce();
  expect(launch).toHaveBeenCalledOnce();
});

it.each([false, undefined])(
  'cancelled confirmation (%s) never changes allowance or wakes work',
  async (confirmed) => {
    const id = await fail();
    const before = fixture.db!.captureJob(id);
    vi.mocked(fixture.ctx.ui.confirm).mockResolvedValue(confirmed as boolean);
    await command(`capture retry ${id}`);
    expect(fixture.db!.captureJob(id)).toEqual(before);
    expect(launch).not.toHaveBeenCalled();
  },
);

it.each([
  { mode: 'print', hasUI: false },
  { mode: 'json', hasUI: false },
  { mode: 'rpc', hasUI: true },
] as const)(
  'rejects $mode retry even if a confirm implementation would approve',
  async ({ mode, hasUI }) => {
    const id = await fail();
    const before = fixture.db!.captureJob(id);
    vi.mocked(fixture.ctx.ui.confirm).mockResolvedValue(true);
    await fixture.commands
      .get('remembrancer')!
      .handler(`capture retry ${id}`, { ...fixture.ctx, hasUI, mode });
    expect(fixture.ctx.ui.confirm).not.toHaveBeenCalled();
    expect(fixture.db!.captureJob(id)).toEqual(before);
    expect(launch).not.toHaveBeenCalled();
    expect(fixture.ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining('explicit UI confirmation'),
      'error',
    );
  },
);

it('rejects prefixes and batch requests without confirmation', async () => {
  const id = await fail();
  const before = fixture.db!.captureJob(id);
  await command(`capture retry ${id.slice(0, 8)}`);
  await command(`capture retry ${id} ${id}`);
  expect(fixture.ctx.ui.confirm).not.toHaveBeenCalled();
  expect(fixture.db!.captureJob(id)).toEqual(before);
  expect(launch).not.toHaveBeenCalled();
});

it('rejects stale confirmation after another connection deliberately retries', async () => {
  const id = await fail();
  vi.mocked(fixture.ctx.ui.confirm).mockImplementation(async () => {
    fixture.db!.retryCaptureJob(id, fixture.db!.captureJob(id)!.revision);
    return true;
  });
  await command(`capture retry ${id}`);
  expect(fixture.db!.captureJob(id)).toMatchObject({ attemptCount: 0 });
  expect(fixture.ctx.ui.notify).toHaveBeenCalledWith(
    expect.stringContaining('Capture control failed:'),
    'error',
  );
  expect(launch).not.toHaveBeenCalled();
});

it('only one of two pending confirmations grants a fresh allowance', async () => {
  const id = await fail();
  const revision = fixture.db!.captureJob(id)!.revision;
  const confirmations: Array<(approved: boolean) => void> = [];
  vi.mocked(fixture.ctx.ui.confirm).mockImplementation(
    () => new Promise<boolean>((resolve) => confirmations.push(resolve)),
  );
  const first = command(`capture retry ${id}`);
  const second = command(`capture retry ${id}`);
  expect(confirmations).toHaveLength(2);
  confirmations[0]!(true);
  await first;
  confirmations[1]!(true);
  await second;
  expect(fixture.db!.captureJob(id)).toMatchObject({ revision: revision + 1, attemptCount: 0 });
  expect(launch).toHaveBeenCalledOnce();
  expect(fixture.ctx.ui.notify).toHaveBeenCalledWith(
    expect.stringContaining('Capture control failed:'),
    'error',
  );
});

it('resume does not replenish stopped allowance and launch failure leaves state saved', async () => {
  const id = await fail();
  const before = fixture.db!.captureJob(id);
  await command('capture pause');
  launch.mockRejectedValueOnce(new Error('offline launcher'));
  await command('capture resume');
  expect(fixture.db!.captureStatus().paused).toBe(false);
  expect(fixture.db!.captureJob(id)).toEqual(before);
  expect(fixture.ctx.ui.notify).toHaveBeenCalledWith(
    expect.stringContaining('state saved; worker launch failed'),
    'warning',
  );
});

import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, expect, it, vi } from 'vitest';
import { captureAnswer, providerInstruction, stepWork } from './fixtures/capture-steps.js';
import { writeCompletion } from './fixtures/openai-loopback.js';
import * as reviewer from '../extensions/remembrancer/reviewer.js';
import * as taskwarrior from '../extensions/remembrancer/taskwarrior.js';
import * as handoffs from '../extensions/remembrancer/capture-handoff.js';
import { CheckpointStore } from '../extensions/remembrancer/checkpoints.js';
import { preserveHandoff, type HandoffInput } from '../extensions/remembrancer/capture-handoff.js';
import {
  launchCaptureWorker,
  runCaptureWorker,
} from '../extensions/remembrancer/capture-worker.js';
import type { reviewPreparedCapture } from '../extensions/remembrancer/capture.js';
import { CaptureRetryableError } from '../extensions/remembrancer/capture-jobs.js';
import { readProposalNotice } from '../extensions/remembrancer/capture-notices.js';

const dirs: string[] = [];
const children = new Set<ChildProcess>();
const workerPids = new Set<number>();
const taskPidFiles = new Set<string>();
const servers: Server[] = [];
let relocatedPackage: string | undefined;
let packageDir: string | undefined;
afterAll(() => {
  if (packageDir) rmSync(packageDir, { recursive: true, force: true });
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
    }
  }
  children.clear();
  for (const pid of workerPids) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* already exited */
    }
    await waitFor(() => {
      try {
        process.kill(pid, 0);
        return false;
      } catch {
        return true;
      }
    });
  }
  workerPids.clear();
  for (const file of taskPidFiles) {
    if (!existsSync(file)) continue;
    for (const pid of readFileSync(file, 'utf8').trim().split('\n').map(Number)) {
      if (!Number.isSafeInteger(pid) || pid <= 1) continue;
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* already exited */
      }
      await waitFor(() => {
        try {
          process.kill(pid, 0);
          return false;
        } catch {
          return true;
        }
      });
    }
  }
  taskPidFiles.clear();
  for (const server of servers) {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
  servers.length = 0;
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});
const bootstrap = fileURLToPath(
  new URL('../extensions/remembrancer/capture-worker-bootstrap.mjs', import.meta.url),
);
const hostEntry = realpathSync(
  process.env['PI_REMEMBRANCER_TEST_PI_ENTRY'] ??
    fileURLToPath(
      new URL('../node_modules/@earendil-works/pi-coding-agent/dist/cli.js', import.meta.url),
    ),
);
const nodeExecutable = process.env['PI_REMEMBRANCER_TEST_NODE'] ?? process.execPath;
const record = (value: unknown) => JSON.stringify(value) + '\n';
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'detached-capture-'));
  dirs.push(dir);
  const source = join(dir, 'session.jsonl');
  writeFileSync(
    source,
    record({ type: 'session', version: 3, id: 'saved', cwd: dir }) +
      record({
        type: 'message',
        id: 'promise',
        parentId: null,
        timestamp: '2026-11-16T00:00:00.000Z',
        message: { role: 'user', content: 'Send Maya the comparison', timestamp: Date.now() },
      }),
  );
  const database = join(dir, 'db.sqlite');
  const store = new CheckpointStore(database);
  store.close();
  const agentDir = join(dir, 'agent');
  mkdirSync(agentDir);
  const input: HandoffInput = {
    id: 'first',
    inbox: join(dir, 'inbox'),
    source: { file: source, sessionId: 'saved' },
    execution: {
      cwd: dir,
      agentDir,
      authorization: { autoCapture: true, disabled: false },
      host: { nodeExecutable, piEntry: hostEntry },
      runtime: {
        projectTrusted: true,
        thinkingLevel: 'high',
        model: {
          provider: 'offline',
          id: 'not-in-catalog',
          name: 'Selected model',
          api: 'openai-completions',
          baseUrl: 'http://127.0.0.1:1/v1',
          reasoning: true,
          input: ['text'],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 32768,
          maxTokens: 1024,
          compat: { supportsReasoningEffort: true, supportsDeveloperRole: false },
        },
      },
    },
  };
  return { dir, database, input, inbox: input.inbox, agentDir };
}
function readAll(current: Parameters<typeof reviewPreparedCapture>[0]) {
  let page;
  do {
    page = current.page() as { hasMore: boolean };
  } while (page.hasMore);
}
const emptyReview: typeof reviewPreparedCapture = async (current, _store, _input, check) => {
  readAll(current);
  check();
  current.completion([]);
  return [];
};
function job(database: string, id = 'first') {
  const store = new CheckpointStore(database);
  try {
    return store.captureJob(id);
  } finally {
    store.close();
  }
}
// Advance only the disposable retry timestamp, never sleep for the production delay.
function makeDue(database: string, id = 'first') {
  expect(job(database, id)?.nextAttemptAt).toBeGreaterThan(Date.now());
  const sql = new DatabaseSync(database);
  try {
    sql.exec('PRAGMA busy_timeout = 5000');
    sql.prepare('UPDATE capture_jobs SET next_attempt_at = ? WHERE id = ?').run(Date.now(), id);
  } finally {
    sql.close();
  }
}
async function waitFor(predicate: () => boolean, ms = 15_000) {
  const end = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > end)
      throw Error(
        'Timed out waiting for worker: ' +
          dirs
            .map((dir) =>
              readdirSync(dir, { recursive: true })
                .filter((name) => String(name).endsWith('.capture.log'))
                .map((name) => readFileSync(join(dir, String(name)), 'utf8'))
                .join('\n'),
            )
            .join('\n'),
      );
    await new Promise((r) => setTimeout(r, 20));
  }
}
function isolatedEnv(f: Awaited<ReturnType<typeof fixture>>) {
  return {
    PATH: join(f.dir, 'bin') + ':' + dirname(nodeExecutable),
    HOME: f.dir,
    XDG_STATE_HOME: join(f.dir, 'state'),
    XDG_CONFIG_HOME: join(f.dir, 'config'),
    XDG_CACHE_HOME: join(f.dir, 'cache'),
    PI_CODING_AGENT_DIR: f.agentDir,
    PI_OFFLINE: '1',
    JITI_FS_CACHE: '0',
    TASKRC: join(f.dir, 'taskrc'),
    TASKDATA: join(f.dir, 'tasks'),
  };
}
function launch(f: Awaited<ReturnType<typeof fixture>>, entry = bootstrap) {
  const child = spawn(nodeExecutable, [entry, hostEntry, f.database, f.inbox], {
    env: isolatedEnv(f),
    stdio: 'ignore',
    detached: true,
  });
  children.add(child);
  return child;
}

function control(f: Awaited<ReturnType<typeof fixture>>, action: 'pause' | 'resume') {
  execFileSync(
    nodeExecutable,
    [
      '--loader',
      fileURLToPath(new URL('./fixtures/typescript-loader.mjs', import.meta.url)),
      fileURLToPath(new URL('./fixtures/capture-jobs-child.mjs', import.meta.url)),
      f.database,
      'first',
      `control-${action}`,
      String(Date.now()),
    ],
    { env: isolatedEnv(f), stdio: 'pipe' },
  );
}

it('commits before preparation and never starts work when the durable claim write fails', async () => {
  const f = await fixture();
  await preserveHandoff(f.input);
  const sql = new DatabaseSync(f.database);
  const prepare = vi.spyOn(CheckpointStore.prototype, 'prepareCaptureJob');
  const review = vi.fn(emptyReview);
  try {
    sql.exec(`CREATE TRIGGER claim_fault BEFORE UPDATE OF attempt_count ON capture_jobs
      BEGIN SELECT RAISE(ABORT, 'claim write fault'); END`);
    await expect(runCaptureWorker({ ...f, review })).rejects.toThrow('claim write fault');
    expect(prepare).not.toHaveBeenCalled();
    expect(review).not.toHaveBeenCalled();
    expect(job(f.database)).toMatchObject({ attemptCount: 0, activeAttemptId: null });
    sql.exec('DROP TRIGGER claim_fault');
    prepare.mockRestore();
    const implementation = CheckpointStore.prototype.prepareCaptureJob;
    vi.spyOn(CheckpointStore.prototype, 'prepareCaptureJob').mockImplementation(function (
      this: CheckpointStore,
      owner,
      attempt,
    ) {
      expect(job(f.database)).toMatchObject({ attemptCount: 1, activeAttemptId: attempt.id });
      return implementation.call(this, owner, attempt);
    });
    await runCaptureWorker({ ...f, review });
    expect(review).toHaveBeenCalledOnce();
    expect(job(f.database)).toMatchObject({ state: 'completed', attemptCount: 1 });
  } finally {
    sql.close();
  }
});

it.each([false, true])(
  'never restarts permanent or exhausted jobs on repeated wakes (temporary=%s)',
  async (temporary) => {
    const f = await fixture();
    const saved = await preserveHandoff(f.input);
    const review = vi
      .fn<typeof reviewPreparedCapture>()
      .mockRejectedValue(
        temporary ? new CaptureRetryableError('temporarily unavailable') : Error('unknown failure'),
      );
    await runCaptureWorker({ ...f, review });
    if (temporary) {
      makeDue(f.database);
      await runCaptureWorker({ ...f, review });
    }
    const stopped = job(f.database);
    expect(stopped).toMatchObject({
      retryEligible: false,
      nextAttemptAt: null,
      attemptCount: temporary ? 2 : 1,
    });
    for (let wake = 0; wake < 3; wake++) await runCaptureWorker({ ...f, review });
    expect(review).toHaveBeenCalledTimes(temporary ? 2 : 1);
    expect(job(f.database)).toEqual(stopped);
    expect(existsSync(saved.manifest.snapshot)).toBe(true);
  },
);

it.each([
  ...[
    'Provider returned error',
    'Provider returned error: unknown upstream failure',
    'Provider returned error: PermissionDenied',
    'Provider returned error: 402 Payment Required',
    'Provider returned error: unsupported model',
    'Provider returned error: output limit exceeded',
    'Provider returned error: 500 prompt is too long',
    'Provider returned error: 503 response truncated',
    'Service unavailable: prompt is too long',
    'Provider returned an error: prompt is too long; rate limit',
    'Provider returned an error',
    'The upstream provider returned an error: unknown upstream failure',
    'Provider returned an error: PermissionDenied; The service is temporarily unavailable',
    'Provider returned an error: 402 Payment Required; The service is temporarily unavailable',
    ...['Provider returned error', 'Provider returned an error'].flatMap((wrapper) =>
      [
        'PermissionDenied',
        '402 Payment Required',
        'The requested model is not supported',
        'output limit exceeded',
        'invalid_request_error',
        'Configuration error: request timeout must be positive',
        'prompt is too long',
      ].map((reason) => `${wrapper}: ${reason}; 503 service is temporarily unavailable`),
    ),
  ].map((errorMessage) => ({ errorMessage, retryable: false })),
  ...[
    'Provider returned error: 503 service unavailable',
    'Provider returned error: 429 rate_limit_error',
    'Throttling error: Too many tokens, please retry your request',
    'Provider returned error: Connection error: socket hang up',
    'Provider returned error: Provider overloaded',
    'The upstream provider returned an error: 503 service is temporarily unavailable',
  ].map((errorMessage) => ({ errorMessage, retryable: true })),
])(
  'persists local provider retry classification across wakes ($errorMessage, retryable=$retryable)',
  async ({ errorMessage, retryable }) => {
    const f = await fixture();
    const p = await provider(f);
    p.fail(errorMessage);
    const saved = await preserveHandoff(f.input);
    const first = launch(f);
    expect((await once(first, 'exit'))[0]).toBe(0);
    expect(job(f.database)).toMatchObject({
      state: 'failed',
      attemptCount: 1,
      activeAttemptId: null,
      retryEligible: retryable,
    });
    expect(p.requests).toHaveLength(1);
    if (retryable) {
      const delayed = job(f.database);
      const early = launch(f);
      expect((await once(early, 'exit'))[0]).toBe(0);
      expect(job(f.database)).toEqual(delayed);
      expect(p.requests).toHaveLength(1);
      makeDue(f.database);
      const retry = launch(f);
      expect((await once(retry, 'exit'))[0]).toBe(0);
    }
    const stopped = job(f.database);
    expect(stopped).toMatchObject({
      state: 'failed',
      attemptCount: retryable ? 2 : 1,
      activeAttemptId: null,
      retryEligible: false,
      nextAttemptAt: null,
    });
    const review = vi.fn(emptyReview);
    for (let wake = 0; wake < 3; wake++) await runCaptureWorker({ ...f, review });
    const restarted = launch(f);
    expect((await once(restarted, 'exit'))[0]).toBe(0);
    expect(review).not.toHaveBeenCalled();
    expect(p.requests).toHaveLength(retryable ? 2 : 1);
    expect(job(f.database)).toEqual(stopped);
    expect(existsSync(saved.manifest.snapshot)).toBe(true);
  },
  30_000,
);

it('synchronously fences quick pause/resume and stale callbacks without replacing the pause failure', async () => {
  const f = await fixture();
  await preserveHandoff(f.input);
  let late: (() => unknown) | undefined;
  let paused: ReturnType<typeof job>;
  await runCaptureWorker({
    ...f,
    review: async (current, _store, _input, check) => {
      readAll(current);
      late = () => current.completion([]);
      control(f, 'pause');
      paused = job(f.database);
      control(f, 'resume');
      expect(check).toThrow('durable capture attempt');
      expect(late).toThrow('durable capture attempt');
      return [];
    },
  });
  expect(late).toThrow();
  expect(job(f.database)).toEqual(paused!);
  expect(job(f.database)).toMatchObject({
    attemptCount: 1,
    activeAttemptId: null,
    retryEligible: true,
  });
  await runCaptureWorker({ ...f, review: emptyReview });
  expect(job(f.database)).toEqual(paused!);
});

it('cross-process pause aborts a blocked local provider, persists through wakes and never starts queued jobs', async () => {
  const f = await fixture();
  const p = await provider(f);
  p.block();
  const saved = await preserveHandoff(f.input);
  await preserveHandoff({ ...f.input, id: 'successor' });
  const child = launch(f);
  const exited = once(child, 'exit');
  await waitFor(() => p.requests.length === 1);
  expect(job(f.database)).toMatchObject({ attemptCount: 1 });
  control(f, 'pause');
  const [code] = await exited;
  expect(code).toBe(0);
  // The provider response is still blocked. Worker cancellation does not wait for it.
  expect(p.requests).toHaveLength(1);
  const paused = job(f.database);
  const review = vi.fn(emptyReview);
  await runCaptureWorker({ ...f, review });
  const wake = launch(f);
  expect((await once(wake, 'exit'))[0]).toBe(0);
  expect(review).not.toHaveBeenCalled();
  expect(job(f.database)).toEqual(paused);
  expect(job(f.database, 'successor')).toMatchObject({ state: 'queued', attemptCount: 0 });
  expect(existsSync(saved.manifest.snapshot)).toBe(true);
  control(f, 'resume');
  await runCaptureWorker({ ...f, review });
  expect(review).not.toHaveBeenCalled();
  expect(job(f.database)).toEqual(paused);
  p.release();
});

it.each(['setup', 'cooperative', 'cleanup'])(
  'polls authority during asynchronous %s and forces stuck cleanup to exit after revocation',
  async (stage) => {
    const f = await fixture();
    await provider(f);
    await preserveHandoff(f.input);
    const marker = join(f.dir, 'pause-marker');
    const child = spawn(
      nodeExecutable,
      [
        fileURLToPath(new URL('./fixtures/capture-worker-hang.mjs', import.meta.url)),
        hostEntry,
        f.database,
        f.inbox,
      ],
      {
        env: {
          ...isolatedEnv(f),
          CAPTURE_HANG_STAGE: stage,
          CAPTURE_HANG_MARKER: marker,
          CAPTURE_PAUSE_TEST: '1',
        },
        stdio: ['ignore', 'ignore', 'pipe'],
      },
    );
    children.add(child);
    let stderr = '';
    child.stderr!.on('data', (chunk) => {
      stderr += String(chunk);
    });
    const exited = once(child, 'exit');
    await waitFor(() => existsSync(marker));
    control(f, 'pause');
    const paused = job(f.database);
    control(f, 'resume');
    const [code] = await exited;
    expect(code, stderr).toBe(stage === 'cooperative' ? 0 : 1);
    if (stage === 'cooperative') {
      expect(readFileSync(marker + '.aborted', 'utf8')).toBe('yes');
      expect(readFileSync(marker + '.cleaned', 'utf8')).toBe('yes');
    }
    expect(job(f.database)).toEqual(paused);
    expect(job(f.database)).toMatchObject({ attemptCount: 1, activeAttemptId: null });
  },
  15_000,
);

it('bootstraps a real detached worker when admission had no foreground database', async () => {
  const f = await fixture();
  rmSync(f.database);
  writeFileSync(
    f.input.source.file,
    record({ type: 'session', version: 3, id: 'saved', cwd: f.dir }),
  );
  const handoff = await preserveHandoff(f.input);
  expect(existsSync(f.database)).toBe(false);
  const child = launch(f);
  const [code] = await once(child, 'exit');
  expect(code).toBe(0);
  expect(job(f.database)?.state).toBe('completed');
  expect(existsSync(handoff.manifest.snapshot)).toBe(false);
  expect(await readProposalNotice(f.database)).toEqual({ generation: 0, pending: 0 });
});

it('honors capture-off admission, delays repeated wakes and publishes the final durable attempt', async () => {
  const f = await fixture();
  const handoff = await preserveHandoff(f.input);
  writeFileSync(
    join(f.agentDir, 'settings.json'),
    record({ 'pi-remembrancer': { disabled: true, autoCapture: false } }),
  );
  const review = vi
    .fn<typeof reviewPreparedCapture>()
    .mockRejectedValue(new CaptureRetryableError('provider unavailable'));
  const released = vi.fn(async () => {});
  await runCaptureWorker({ ...f, review, afterRelease: released });
  expect(review).toHaveBeenCalledTimes(1);
  expect(released).toHaveBeenCalledTimes(1);
  const failed = job(f.database);
  expect(failed).toMatchObject({ state: 'failed', retryEligible: true, attemptCount: 1 });
  for (let wake = 0; wake < 3; wake++) await runCaptureWorker({ ...f, review });
  expect(review).toHaveBeenCalledTimes(1);
  expect(job(f.database)).toEqual(failed);
  expect(existsSync(handoff.manifest.snapshot)).toBe(true);
  expect(await readProposalNotice(f.database)).toEqual({ generation: 0, pending: 0 });
  makeDue(f.database);
  await runCaptureWorker({ ...f, review: emptyReview });
  expect(job(f.database)).toMatchObject({ state: 'completed', attemptCount: 2 });
  expect(existsSync(handoff.manifest.snapshot)).toBe(false);
  expect(await readProposalNotice(f.database)).toEqual({ generation: 0, pending: 0 });
  // Already-covered work also produces no proposal notice.
  await preserveHandoff({ ...f.input, id: 'covered' });
  await runCaptureWorker({ ...f, review });
  expect(review).toHaveBeenCalledTimes(1);
  expect(await readProposalNotice(f.database)).toEqual({ generation: 0, pending: 0 });
});

it('does not own the manual lock through model work or cleanup; contention defers quietly', async () => {
  const f = await fixture();
  await preserveHandoff(f.input);
  const manual = new CheckpointStore(f.database);
  manual.claimReview();
  const review = vi.fn(emptyReview);
  await runCaptureWorker({ ...f, review });
  expect(review).not.toHaveBeenCalled();
  expect(existsSync(f.database + '.capture.log')).toBe(false);
  expect(job(f.database)).toMatchObject({ attemptCount: 0, activeAttemptId: null });
  manual.releaseReview();
  let checked = false;
  await runCaptureWorker({
    ...f,
    review: async (...args) => {
      if (!checked) {
        manual.claimReview();
        manual.releaseReview();
        checked = true;
      }
      return emptyReview(...args);
    },
  });
  expect(job(f.database)).toMatchObject({ state: 'failed', attemptCount: 1 });
  makeDue(f.database);
  await runCaptureWorker({ ...f, review: emptyReview });
  expect(job(f.database)).toMatchObject({ state: 'completed', attemptCount: 2 });
  manual.close();
});

it('releases and rechecks handoffs, reacquires fresh authority, and fences old callbacks', async () => {
  const f = await fixture();
  await preserveHandoff(f.input);
  let oldCheck: (() => void) | undefined;
  let latePage: (() => unknown) | undefined;
  let released = false;
  const calls: string[] = [];
  const graceMs = 50;
  await runCaptureWorker({
    ...f,
    graceMs,
    review: async (...args) => {
      calls.push(args[2].sessionId);
      if (!oldCheck) {
        oldCheck = args[3];
        latePage = () => args[0].page();
      } else {
        expect(oldCheck).toThrow();
        expect(latePage).toThrow();
        // A completed attempt cannot arm termination or revoke this attempt.
        await new Promise((resolve) => setTimeout(resolve, graceMs * 2));
        expect(args[2].signal!.aborted).toBe(false);
        expect(args[3]).not.toThrow();
      }
      return emptyReview(...args);
    },
    afterRelease: async () => {
      if (released) return;
      released = true;
      expect(oldCheck).toThrow();
      const file = join(f.dir, 'other.jsonl');
      writeFileSync(
        file,
        readFileSync(f.input.source.file, 'utf8').replace('"id":"saved"', '"id":"other"'),
      );
      await preserveHandoff({ ...f.input, id: 'second', source: { file, sessionId: 'other' } });
    },
  });
  expect(job(f.database)?.state).toBe('completed');
  expect(job(f.database, 'second')?.state).toBe('completed');
  expect(calls).toEqual(['saved', 'other']);
  expect(oldCheck).toThrow();
  // The stale check still throws after worker shutdown, without an orphan timer.
  await new Promise((resolve) => setTimeout(resolve, graceMs * 2));
});

it.each([true, false])(
  'uses originating project trust (%s), including temporary trust without a trust file',
  async (trusted) => {
    const f = await fixture();
    f.input.execution.runtime!.projectTrusted = trusted;
    mkdirSync(join(f.dir, '.pi'));
    writeFileSync(join(f.agentDir, 'settings.json'), record({ defaultThinkingLevel: 'off' }));
    writeFileSync(join(f.dir, '.pi/settings.json'), record({ defaultThinkingLevel: 'low' }));
    await preserveHandoff(f.input);
    await runCaptureWorker({
      ...f,
      review: async (...args) => {
        expect(args[2].settingsManager!.getDefaultThinkingLevel()).toBe(trusted ? 'low' : 'off');
        expect(args[2].thinkingLevel).toBe('high');
        expect(args[2].agentDir).toBe(f.agentDir);
        expect(existsSync(join(f.agentDir, 'trust.json'))).toBe(false);
        return emptyReview(...args);
      },
    });
    expect(job(f.database)?.state).toBe('completed');
  },
);

it('observes admission while the exiting owner still holds its singleton, even when that launch loses contention', async () => {
  const f = await fixture();
  await preserveHandoff(f.input);
  let launched: Promise<void> | undefined;
  await runCaptureWorker({
    ...f,
    review: async (...args) => {
      const file = join(f.dir, 'new.jsonl');
      if (args[2].sessionId === 'saved') {
        writeFileSync(
          file,
          readFileSync(f.input.source.file, 'utf8').replace('"id":"saved"', '"id":"new"'),
        );
        await preserveHandoff({ ...f.input, id: 'next', source: { file, sessionId: 'new' } });
        const duplicate = launch(f);
        launched = once(duplicate, 'exit').then(([code]) => {
          expect(code).toBe(0);
        });
        await launched;
      }
      return emptyReview(...args);
    },
  });
  await launched;
  expect(job(f.database, 'next')?.state).toBe('completed');
});

it('a launch after the departing owner final recheck starts another owner', async () => {
  const f = await fixture();
  await preserveHandoff(f.input);
  await runCaptureWorker({ ...f, review: emptyReview });
  // Same source is already covered, so the new owner needs no model call.
  await preserveHandoff({ ...f.input, id: 'after-exit' });
  const child = launch(f);
  const [code] = await once(child, 'exit');
  expect(code).toBe(0);
  expect(job(f.database, 'after-exit')?.state).toBe('completed');
});

it('invalidates timed-out output even if it returns before cleanup grace expires', async () => {
  const f = await fixture();
  const saved = await preserveHandoff(f.input);
  const attempts: { signal: AbortSignal; check: () => void; aborted: boolean }[] = [];
  await runCaptureWorker({
    ...f,
    budgetMs: 1_000,
    graceMs: 200,
    review: async (current, _db, input, check) => {
      const attempt = { signal: input.signal!, check, aborted: false };
      attempts.push(attempt);
      readAll(current);
      await once(attempt.signal, 'abort');
      attempt.aborted = true;
      expect(check).toThrow();
      return [];
    },
  });
  expect(attempts).toHaveLength(1);
  for (const attempt of attempts) {
    expect(attempt.aborted).toBe(true);
    expect(attempt.signal.aborted).toBe(true);
    expect(attempt.check).toThrow();
  }
  expect(job(f.database)).toMatchObject({ state: 'failed', retryEligible: true });
  const db = new CheckpointStore(f.database);
  expect(db.reviewed()).toEqual([]);
  expect(db.proposals()).toEqual([]);
  db.close();
  expect(existsSync(saved.manifest.snapshot)).toBe(true);
});

it.each(['setup', 'prompt', 'cleanup'])(
  'self-terminates a never-settling asynchronous %s after grace, releasing ownership and retaining evidence',
  async (stage) => {
    const f = await fixture();
    await provider(f);
    const saved = await preserveHandoff(f.input);
    const marker = join(f.dir, 'hang-marker');
    const entry = fileURLToPath(new URL('./fixtures/capture-worker-hang.mjs', import.meta.url));
    const child = spawn(nodeExecutable, [entry, hostEntry, f.database, f.inbox], {
      env: { ...isolatedEnv(f), CAPTURE_HANG_STAGE: stage, CAPTURE_HANG_MARKER: marker },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    children.add(child);
    let stderr = '';
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });
    const ended = once(child, 'exit');
    await waitFor(() => existsSync(marker));
    expect(child.exitCode).toBeNull();
    const manual = new CheckpointStore(f.database);
    manual.claimReview();
    manual.releaseReview();
    manual.close();
    const [code] = await ended;
    expect(code, stderr).toBe(1);
    expect(existsSync(marker), stderr).toBe(true);
    expect(readFileSync(marker, 'utf8')).toBe(stage);
    expect(job(f.database)).toMatchObject({
      state: 'failed',
      retryEligible: true,
      diagnostic: 'Capture review timed out',
    });
    expect(existsSync(saved.manifest.snapshot)).toBe(true);
    makeDue(f.database);
    await runCaptureWorker({ ...f, review: emptyReview });
    expect(job(f.database)?.state).toBe('completed');
  },
  15_000,
);

it('reports a failed direct launch without deleting or importing the handoff', async () => {
  const f = await fixture();
  const saved = await preserveHandoff(f.input);
  await expect(
    launchCaptureWorker(f.database, f.inbox, {
      nodeExecutable: join(f.dir, 'missing'),
      piEntry: hostEntry,
    }),
  ).rejects.toThrow();
  expect(existsSync(saved.ready)).toBe(true);
  expect(job(f.database)).toBeUndefined();
});

it('retains a handoff after bootstrap failure following successful spawn; a later wake recovers', async () => {
  const f = await fixture();
  const saved = await preserveHandoff(f.input);
  const child = spawn(
    nodeExecutable,
    [bootstrap, join(f.dir, 'missing-pi', 'cli.js'), f.database, f.inbox],
    { env: isolatedEnv(f), stdio: 'ignore' },
  );
  children.add(child);
  const [code] = await once(child, 'exit');
  expect(code).toBe(1);
  expect(existsSync(saved.ready)).toBe(true);
  expect(readFileSync(f.database + '.capture.log', 'utf8')).toContain('Worker bootstrap failed');
  await runCaptureWorker({ ...f, review: emptyReview });
  expect(job(f.database)?.state).toBe('completed');
});

async function provider(
  f: Awaited<ReturnType<typeof fixture>>,
  empty = false,
  onRequest?: (instruction: string, count: number) => void,
) {
  const requests: { body: Record<string, unknown>; headers: Record<string, unknown> }[] = [];
  let block = false;
  let failure: string | undefined;
  const blocked = new Set<() => void>();
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    requests.push({ body, headers: req.headers });
    const pid = Number(req.headers['x-worker-pid']);
    if (Number.isSafeInteger(pid) && pid > 1 && pid !== process.pid) workerPids.add(pid);
    if (block) await new Promise<void>((r) => blocked.add(r));
    if (failure) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(`data: ${JSON.stringify({ error: { message: failure } })}\n\n`);
      return;
    }
    const messages = body.messages as { role: string; content?: string }[];
    const instruction = providerInstruction(messages);
    onRequest?.(instruction, requests.length);
    const name = 'remembrancer_step';
    const args = { result: { answer: captureAnswer(instruction, empty) } };
    writeCompletion(
      res,
      {
        role: 'assistant',
        tool_calls: [
          {
            index: 0,
            id: `call_${name}`,
            type: 'function',
            function: { name, arguments: JSON.stringify(args) },
          },
        ],
      },
      'tool_calls',
      'not-in-catalog',
    );
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const address = server.address() as { port: number };
  f.input.execution.runtime!.model.baseUrl = `http://127.0.0.1:${address.port}/v1`;
  f.input.execution.runtime!.headerNames = ['X-Command', 'X-Worker-Pid'];
  writeFileSync(
    join(f.agentDir, 'models.json'),
    record({
      providers: {
        offline: {
          api: 'openai-completions',
          baseUrl: f.input.execution.runtime!.model.baseUrl,
          headers: { 'X-Command': '!printf command-header', 'X-Worker-Pid': '!printf "$PPID"' },
          models: [],
        },
      },
    }),
  );
  const lockCheck = `import {DatabaseSync} from 'node:sqlite'; import {writeFileSync} from 'node:fs';
    const lock=new DatabaseSync(${JSON.stringify(f.database + '.lock')}); lock.exec('BEGIN IMMEDIATE'); lock.close();`;
  const credentialCommand = join(f.dir, 'credential.mjs');
  writeFileSync(
    credentialCommand,
    `${lockCheck} writeFileSync(${JSON.stringify(join(f.dir, 'auth-outside-lock'))},'yes'); process.stdout.write('fixture-key');`,
  );
  writeFileSync(
    join(f.agentDir, 'auth.json'),
    record({
      offline: {
        type: 'api_key',
        key: `!${JSON.stringify(nodeExecutable)} ${JSON.stringify(credentialCommand)}`,
      },
    }),
  );
  mkdirSync(join(f.dir, 'bin'));
  writeFileSync(
    join(f.dir, 'bin', 'task'),
    `#!${nodeExecutable}\n${lockCheck}
    if(!process.argv.includes('export'))process.exit(1);
    writeFileSync(${JSON.stringify(join(f.dir, 'tasks-outside-lock'))},'yes'); process.stdout.write('[]');`,
    { mode: 0o700 },
  );
  writeFileSync(
    join(f.agentDir, 'settings.json'),
    record({ defaultThinkingLevel: 'off', 'pi-remembrancer': { autoCapture: false } }),
  );
  mkdirSync(join(f.agentDir, 'extensions'));
  writeFileSync(
    join(f.agentDir, 'extensions', 'forbidden.ts'),
    'throw Error("Arbitrary extension loaded");',
  );
  return {
    requests,
    fail: (message: string) => {
      failure = message;
    },
    block: () => {
      block = true;
    },
    release: () => {
      block = false;
      for (const resume of blocked) resume();
      blocked.clear();
    },
  };
}

it.each(['running', 'crashed'] as const)(
  'runs relocated lifecycle admission through real detached review, capture-off recovery of %s work and committed TUI notice',
  async (state) => {
    const crash = state === 'crashed';
    const f = await fixture();
    f.database = join(f.dir, 'state', 'pi-remembrancer', 'checkpoints.sqlite3');
    f.inbox = f.input.inbox = join(dirname(f.database), 'capture-inbox');
    const p = await provider(f);
    p.block();
    writeFileSync(
      join(f.agentDir, 'settings.json'),
      record({ 'pi-remembrancer': { autoCapture: true } }),
    );
    // One read-only publication artifact; every case has independent runtime state.
    if (!relocatedPackage) {
      packageDir = mkdtempSync(join(tmpdir(), 'capture-packed-'));
      const packEnv = {
        ...isolatedEnv(f),
        PATH: process.env['PATH'],
        npm_config_cache: join(packageDir, 'npm-cache'),
      };
      const packed = JSON.parse(
        execFileSync(
          'npm',
          ['pack', '--json', '--ignore-scripts', '--pack-destination', packageDir],
          {
            cwd: resolve('.'),
            env: packEnv,
            encoding: 'utf8',
          },
        ),
      ) as { filename: string }[];
      execFileSync('tar', ['-xzf', join(packageDir, packed[0]!.filename), '-C', packageDir], {
        env: packEnv,
      });
      relocatedPackage = join(packageDir, 'package');
    }
    const relocated = relocatedPackage;
    expect(existsSync(join(relocated, 'node_modules'))).toBe(false);
    const inputFile = join(f.dir, 'lifecycle-input.json');
    writeFileSync(inputFile, JSON.stringify(f.input));
    const entry = fileURLToPath(new URL('./fixtures/capture-lifecycle-child.mjs', import.meta.url));
    const noticeFile = join(f.dir, 'notifications.json');
    const lifecycle = (action: string) => {
      const child = spawn(
        nodeExecutable,
        [entry, hostEntry, relocated, inputFile, action, noticeFile],
        {
          env: isolatedEnv(f),
          cwd: f.dir,
          stdio: ['ignore', 'ignore', 'pipe'],
        },
      );
      children.add(child);
      return child;
    };
    // Admission acknowledges only preservation/spawn. Its parent exits before the model replies.
    const child = lifecycle('admit');
    let stderr = '';
    child.stderr!.on('data', (chunk) => {
      stderr += String(chunk);
    });
    // Natural exit must happen while the detached provider is still blocked.
    await waitFor(() => child.exitCode !== null || child.signalCode !== null, 8_000);
    expect(child.exitCode, stderr).toBe(0);
    await waitFor(() => p.requests.length === 1);
    const workerPid = Number(p.requests[0]!.headers['x-worker-pid']);
    expect(workerPid).toBeGreaterThan(0);
    const snapshot = readdirSync(f.inbox).find((name) => name.endsWith('.snapshot.jsonl'))!;
    const id = snapshot.replace('.snapshot.jsonl', '');
    expect(job(f.database, id)?.state).toBe('queued');
    expect(readFileSync(join(f.inbox, snapshot), 'utf8')).toBe(
      readFileSync(f.input.source.file, 'utf8'),
    );
    expect(readFileSync(f.database).includes(Buffer.from('secret-do-not-save'))).toBe(false);
    const manual = new CheckpointStore(f.database);
    manual.claimReview();
    manual.releaseReview();
    manual.close();
    writeFileSync(
      join(f.agentDir, 'settings.json'),
      record({ 'pi-remembrancer': { autoCapture: false } }),
    );
    if (crash) {
      process.kill(workerPid, 'SIGKILL');
      await waitFor(() => {
        try {
          process.kill(workerPid, 0);
          return false;
        } catch {
          return true;
        }
      });
      expect(job(f.database, id)?.state).toBe('queued');
      expect(existsSync(join(f.inbox, snapshot))).toBe(true);
    }
    // Interrupted work is recovered once and delayed. Context races also delay,
    // rather than launching another whole review immediately.
    p.release();
    if (crash) await runCaptureWorker({ ...f, review: emptyReview });
    else await waitFor(() => job(f.database, id)?.state === 'failed');
    expect(job(f.database, id)).toMatchObject({ attemptCount: 1, retryEligible: true });
    makeDue(f.database, id);
    // A capture-off terminal uses the actual recovery launch and asynchronous notice tick.
    const observer = lifecycle('observe');
    observer.stderr!.on('data', (chunk) => {
      stderr += String(chunk);
    });
    const observed = once(observer, 'exit');
    await waitFor(() => existsSync(noticeFile + '.started'));
    p.release();
    const [observerCode] = await observed;
    expect(observerCode, stderr).toBe(0);
    expect(JSON.parse(readFileSync(noticeFile, 'utf8'))).toEqual([
      { message: '1 task proposals · /remembrancer proposals', level: 'info' },
    ]);
    expect(job(f.database, id)?.state).toBe('completed');
    expect(existsSync(join(f.inbox, snapshot))).toBe(false);
    expect(await readProposalNotice(f.database)).toEqual({ generation: 1, pending: 1 });
    const finalWorkerPid = Number(p.requests.at(-1)!.headers['x-worker-pid']);
    await waitFor(() => {
      try {
        process.kill(finalWorkerPid, 0);
        return false;
      } catch {
        return true;
      }
    });
    // Manual ownership and observer enrollment change review context. A running
    // attempt must discard/reprepare; a recovered attempt starts after enrollment.
    expect(
      p.requests.filter(
        ({ body }) =>
          stepWork(providerInstruction(body['messages'] as { role: string; content: string }[]))
            .range,
      ),
    ).toHaveLength(2);
    expect(p.requests[0]!.body['model']).toBe('not-in-catalog');
    expect(p.requests[0]!.body['reasoning_effort']).toBe('high');
    expect(p.requests[0]!.headers['authorization']).toBe('Bearer fixture-key');
    expect(p.requests[0]!.headers['x-command']).toBe('command-header');
    expect(existsSync(join(f.dir, 'auth-outside-lock'))).toBe(true);
    expect(existsSync(join(f.dir, 'tasks-outside-lock'))).toBe(true);
    const tools = p.requests[0]!.body['tools'] as { function: { name: string } }[];
    expect(tools.map((t) => t.function.name)).toEqual(['remembrancer_step']);
    const store = new CheckpointStore(f.database);
    expect(store.proposals()).toHaveLength(1);
    expect(store.reviewed()).toHaveLength(1);
    store.close();
    expect(readFileSync(f.database).includes(Buffer.from('fixture-key'))).toBe(false);
  },
  30_000,
);

it('duplicate launches run only one reviewer; killing an owner leaves queued evidence for recovery', async () => {
  const f = await fixture();
  const p = await provider(f);
  p.block();
  const saved = await preserveHandoff(f.input);
  const first = launch(f);
  await waitFor(() => p.requests.length === 1);
  const manual = new CheckpointStore(f.database);
  manual.claimReview();
  manual.releaseReview();
  manual.close();
  const second = launch(f);
  const [code] = await once(second, 'exit');
  expect(code).toBe(0);
  expect(p.requests).toHaveLength(1);
  expect(job(f.database)?.state).toBe('queued');
  const ended = once(first, 'exit');
  first.kill('SIGKILL');
  await ended;
  expect(existsSync(saved.manifest.snapshot)).toBe(true);
  await runCaptureWorker({ ...f, review: emptyReview });
  expect(job(f.database)).toMatchObject({ state: 'failed', attemptCount: 1 });
  makeDue(f.database);
  await runCaptureWorker({ ...f, review: emptyReview });
  expect(job(f.database)).toMatchObject({ state: 'completed', attemptCount: 2 });
}, 25_000);

it('persists two actual worker deaths across competing launches and repeated restart wakes', async () => {
  const f = await fixture();
  const p = await provider(f);
  p.block();
  const saved = await preserveHandoff(f.input);
  const review = vi.fn(emptyReview);
  for (let count = 1; count <= 2; count++) {
    const child = launch(f);
    await waitFor(() => p.requests.length === count);
    const active = job(f.database);
    expect(active).toMatchObject({ state: 'queued', attemptCount: count });
    expect(active!.activeAttemptId).toEqual(expect.any(String));
    const contender = launch(f);
    expect((await once(contender, 'exit'))[0]).toBe(0);
    expect(job(f.database)).toEqual(active);
    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    await exited;
    await runCaptureWorker({ ...f, review });
    expect(review).not.toHaveBeenCalled();
    expect(job(f.database)).toMatchObject({
      state: 'failed',
      attemptCount: count,
      activeAttemptId: null,
      retryEligible: count < 2,
    });
    for (let wake = 0; wake < 2; wake++) await runCaptureWorker({ ...f, review });
    expect(p.requests).toHaveLength(count);
    if (count < 2) makeDue(f.database);
  }
  const stopped = job(f.database);
  const wake = launch(f);
  expect((await once(wake, 'exit'))[0]).toBe(0);
  expect(job(f.database)).toEqual(stopped);
  expect(p.requests).toHaveLength(2);
  expect(existsSync(saved.manifest.snapshot)).toBe(true);
  p.release();
}, 25_000);

it('expires the original attempt after earlier complete SDK steps and retries the whole review without publishing partial work', async () => {
  const f = await fixture();
  // The third step scans a real candidate after extraction and folding. A valid
  // unmatched add no longer needs a redundant materialization request.
  vi.spyOn(taskwarrior, 'readTaskCatalog').mockResolvedValue([
    {
      uuid: '12345678-1234-1234-1234-123456789abc',
      status: 'pending',
      description: 'Unrelated',
    },
  ]);
  const now = performance.now.bind(performance);
  let elapsed = 0;
  let expire = true;
  vi.spyOn(performance, 'now').mockImplementation(() => now() + elapsed);
  const p = await provider(f, false, (_instruction, count) => {
    if (expire) elapsed = Math.min(count * 20_000, 50_000);
  });
  const saved = await preserveHandoff(f.input);
  const signals: AbortSignal[] = [];
  const completed: reviewer.ReviewerStepResult[] = [];
  const failures: unknown[] = [];
  const realStep = reviewer.runReviewerStep;
  vi.spyOn(reviewer, 'runReviewerStep').mockImplementation(async (input) => {
    signals.push(input.signal!);
    try {
      const result = await realStep(input);
      completed.push(result);
      return result;
    } catch (error) {
      failures.push(error);
      throw error;
    }
  });
  const publish = vi.spyOn(CheckpointStore.prototype, 'finishCaptureJob');
  await runCaptureWorker({ ...f, budgetMs: 50_000 });
  expect(p.requests).toHaveLength(3);
  expect(completed).toHaveLength(2);
  expect(completed.every((result) => result.status === 'handoff')).toBe(true);
  expect(new Set(signals).size).toBe(1);
  expect(signals[0]!.aborted).toBe(true);
  expect(failures).toHaveLength(1);
  expect(failures[0]).toBeInstanceOf(CaptureRetryableError);
  expect((failures[0] as Error).message).toBe('Capture review timed out');
  expect(publish).not.toHaveBeenCalled();
  expect(job(f.database)).toMatchObject({ state: 'failed', attemptCount: 1, retryEligible: true });
  let db = new CheckpointStore(f.database);
  expect(db.reviewed()).toEqual([]);
  expect(db.proposals()).toEqual([]);
  db.close();
  expect(existsSync(saved.manifest.snapshot)).toBe(true);

  // No real timer wait: rerun every SDK step under a new whole-attempt deadline.
  expire = false;
  elapsed = 0;
  makeDue(f.database);
  await runCaptureWorker({ ...f, budgetMs: 50_000 });
  expect(p.requests).toHaveLength(6);
  expect(signals[3]).not.toBe(signals[0]);
  expect(new Set(signals.slice(3)).size).toBe(1);
  expect(completed).toHaveLength(5);
  expect(
    providerInstruction(p.requests[3]!.body['messages'] as { role: string; content: string }[]),
  ).toBe(
    providerInstruction(p.requests[0]!.body['messages'] as { role: string; content: string }[]),
  );
  expect(publish).toHaveBeenCalledOnce();
  expect(publish.mock.calls[0]![2]).toHaveLength(1);
  expect(job(f.database)).toMatchObject({ state: 'completed', attemptCount: 2 });
  db = new CheckpointStore(f.database);
  expect(db.reviewed()).not.toEqual([]);
  expect(db.proposals()).toHaveLength(1);
  db.close();
});

it('reaches atomic publication with a staged real-SDK proposal before an injected storage failure', async () => {
  const f = await fixture();
  vi.spyOn(taskwarrior, 'readTaskCatalog').mockResolvedValue([]);
  const p = await provider(f);
  const saved = await preserveHandoff(f.input);
  const failure = new Error('fixture publication failed');
  const publish = vi
    .spyOn(CheckpointStore.prototype, 'finishCaptureJob')
    .mockImplementationOnce(() => {
      throw failure;
    });
  await runCaptureWorker(f);
  expect(
    p.requests.some(
      ({ body }) =>
        stepWork(providerInstruction(body['messages'] as { role: string; content: string }[]))
          .observation,
    ),
  ).toBe(true);
  expect(publish).toHaveBeenCalledOnce();
  const submissions = publish.mock.calls[0]![2];
  expect(submissions).toHaveLength(1);
  expect(submissions[0]).toMatchObject({
    change: { operation: 'add', fields: { description: 'comparison' } },
    references: [
      expect.objectContaining({ entryId: 'promise', quote: 'Send Maya the comparison' }),
    ],
  });
  expect(job(f.database)).toMatchObject({ state: 'failed', attemptCount: 1, retryEligible: false });
  const db = new CheckpointStore(f.database);
  expect(db.reviewed()).toEqual([]);
  expect(db.proposals()).toEqual([]);
  db.close();
  expect(existsSync(saved.manifest.snapshot)).toBe(true);
});

it('rejects synchronous reviewer output after absolute expiry before timers can run', async () => {
  const f = await fixture();
  const saved = await preserveHandoff(f.input);
  let deadlineRejections = 0;
  let validationRejections = 0;
  let earlyAborts = 0;
  await runCaptureWorker({
    ...f,
    budgetMs: 25,
    review: async (current, _db, input, check) => {
      readAll(current);
      const until = performance.now() + 60;
      while (performance.now() < until) {
        /* synchronous overrun */
      }
      if (input.signal!.aborted) earlyAborts++;
      try {
        check();
      } catch {
        deadlineRejections++;
      }
      try {
        check();
        current.completion([]);
      } catch {
        validationRejections++;
      }
      return [];
    },
  });
  expect(earlyAborts).toBe(0);
  expect(deadlineRejections).toBe(1);
  expect(validationRejections).toBe(1);
  expect(job(f.database)).toMatchObject({ state: 'failed', retryEligible: true });
  const db = new CheckpointStore(f.database);
  expect(db.reviewed()).toEqual([]);
  expect(db.proposals()).toEqual([]);
  db.close();
  expect(existsSync(saved.manifest.snapshot)).toBe(true);
});

it('scopes cwd through awaited reviewer cleanup, restores it on failure and omits provider secrets from diagnostics', async () => {
  const f = await fixture();
  await preserveHandoff(f.input);
  const original = process.cwd();
  const cleanupCwds: string[] = [];
  const sentinel = 'provider-body-credential-command-secret';
  await runCaptureWorker({
    ...f,
    review: async () => {
      try {
        throw Object.assign(Error(sentinel), { name: sentinel, cause: Error(sentinel) });
      } finally {
        await new Promise((resolve) => setTimeout(resolve, 1));
        cleanupCwds.push(process.cwd());
      }
    },
  });
  expect(process.cwd()).toBe(original);
  expect(cleanupCwds).toEqual([realpathSync(f.dir)]);
  const diagnostic = job(f.database)!.diagnostic!;
  expect(diagnostic).toContain('reviewer-setup-prompt-cleanup');
  expect(diagnostic).toContain('first');
  expect(diagnostic).not.toContain(sentinel);
  expect(readFileSync(f.database + '.capture.log', 'utf8')).not.toContain(sentinel);
});

it('drains one physical inbox through symlink and real paths without changing accepted bodies', async () => {
  const f = await fixture();
  mkdirSync(f.inbox);
  const alias = join(f.dir, 'alias');
  symlinkSync(f.inbox, alias);
  const first = await preserveHandoff({ ...f.input, inbox: alias });
  const accepted = JSON.parse(readFileSync(first.ready, 'utf8'));
  const review = vi.fn(emptyReview);
  await runCaptureWorker({ ...f, review });
  expect(job(f.database)?.manifest).toEqual(accepted);
  await preserveHandoff({ ...f.input, id: 'second' });
  await runCaptureWorker({ ...f, inbox: alias, review });
  expect(job(f.database, 'second')?.state).toBe('completed');
  expect(review).toHaveBeenCalledTimes(1);
  expect(existsSync(first.manifest.snapshot)).toBe(false);
});

it('persists immutable preparation failure once, retains evidence and blocks its successor', async () => {
  const f = await fixture();
  writeFileSync(f.input.source.file, 'not-json\n');
  const saved = await preserveHandoff(f.input);
  await preserveHandoff({ ...f.input, id: 'successor' });
  const prepare = vi.spyOn(CheckpointStore.prototype, 'prepareCaptureJob');
  const review = vi.fn(emptyReview);
  await runCaptureWorker({ ...f, review });
  const failed = job(f.database);
  expect(failed).toMatchObject({ state: 'failed', retryEligible: false });
  expect(failed!.diagnostic).toContain('invalid');
  expect(prepare).toHaveBeenCalledTimes(1);
  await runCaptureWorker({ ...f, review });
  expect(prepare).toHaveBeenCalledTimes(1);
  expect(review).not.toHaveBeenCalled();
  expect(job(f.database)).toEqual(failed);
  expect(job(f.database, 'successor')?.state).toBe('queued');
  expect(existsSync(saved.manifest.snapshot)).toBe(true);
  prepare.mockRestore();
});

it('repairs completed rows after snapshot cleanup failure without ready signals or reviewer replay', async () => {
  const f = await fixture();
  const saved = await preserveHandoff(f.input);
  const cleanup = vi.spyOn(handoffs, 'cleanupCompletedSnapshot');
  // Fail all cleanup in the first drain, not the database completion.
  cleanup.mockRejectedValue(
    Object.assign(Error('credential-provider-body-command'), { code: 'EACCES' }),
  );
  const review = vi.fn(emptyReview);
  const cwd = process.cwd();
  await runCaptureWorker({ ...f, review });
  expect(process.cwd()).toBe(cwd);
  expect(job(f.database)?.state).toBe('completed');
  expect(existsSync(saved.ready)).toBe(false);
  expect(existsSync(saved.manifest.snapshot)).toBe(true);
  const db = new CheckpointStore(f.database);
  const reviewed = db.reviewed();
  db.close();
  cleanup.mockRestore();
  await runCaptureWorker({ ...f, review });
  expect(review).toHaveBeenCalledTimes(1);
  expect(existsSync(saved.manifest.snapshot)).toBe(false);
  const reopened = new CheckpointStore(f.database);
  expect(reopened.reviewed()).toEqual(reviewed);
  expect(reopened.proposals()).toEqual([]);
  reopened.close();
  const log = readFileSync(f.database + '.capture.log', 'utf8');
  expect(log).toContain('snapshot-cleanup');
  expect(log).toContain('EACCES');
  expect(log).not.toContain('credential-provider-body-command');
  expect(log).not.toContain('contention');
});

it('executes committed imports despite pending signal cleanup, exits once, and retries next wake', async () => {
  const f = await fixture();
  const saved = await preserveHandoff(f.input);
  const original = handoffs.importReadyHandoff;
  const imported = vi
    .spyOn(handoffs, 'importReadyHandoff')
    .mockImplementation(async (store, owner, ready) => {
      // Import transaction commits while the real ready file remains visible.
      const manifest = JSON.parse(readFileSync(ready, 'utf8'));
      return {
        job: store.importCaptureJob(owner, manifest),
        signalCleanupPending: true,
        cleanupDiagnostic: 'Capture ready-cleanup: local-failure (EACCES) [first]',
      };
    });
  const review = vi.fn(emptyReview);
  const released = vi.fn(async () => {});
  await runCaptureWorker({ ...f, review, afterRelease: released });
  expect(imported).toHaveBeenCalledTimes(1);
  expect(released).toHaveBeenCalledTimes(1);
  expect(review).toHaveBeenCalledTimes(1);
  expect(job(f.database)?.state).toBe('completed');
  expect(existsSync(saved.ready)).toBe(true);
  expect(existsSync(saved.manifest.snapshot)).toBe(true);
  imported.mockImplementation(original);
  await runCaptureWorker({ ...f, review });
  expect(review).toHaveBeenCalledTimes(1);
  expect(existsSync(saved.ready)).toBe(false);
  expect(existsSync(saved.manifest.snapshot)).toBe(false);
  imported.mockRestore();
});

it('retains unsupported unimported signals and does not bypass their selection barrier or spin', async () => {
  const f = await fixture();
  const saved = await preserveHandoff(f.input);
  await preserveHandoff({ ...f.input, id: 'later' });
  const manifest = JSON.parse(readFileSync(saved.ready, 'utf8'));
  manifest.version = 2;
  writeFileSync(saved.ready, JSON.stringify(manifest));
  const review = vi.fn(emptyReview);
  const released = vi.fn(async () => {});
  await runCaptureWorker({ ...f, review, afterRelease: released });
  expect(review).not.toHaveBeenCalled();
  expect(released).toHaveBeenCalledTimes(1);
  expect(job(f.database)).toBeUndefined();
  expect(job(f.database, 'later')?.state).toBe('queued');
  expect(existsSync(saved.ready)).toBe(true);
  expect(existsSync(saved.manifest.snapshot)).toBe(true);
});

it('passes the actual attempt signal and awaits cooperative reviewer cleanup before release', async () => {
  const f = await fixture();
  await provider(f);
  await preserveHandoff(f.input);
  const marker = join(f.dir, 'cooperative');
  const child = spawn(
    nodeExecutable,
    [
      fileURLToPath(new URL('./fixtures/capture-worker-hang.mjs', import.meta.url)),
      hostEntry,
      f.database,
      f.inbox,
    ],
    {
      env: { ...isolatedEnv(f), CAPTURE_HANG_STAGE: 'cooperative', CAPTURE_HANG_MARKER: marker },
      stdio: 'ignore',
    },
  );
  children.add(child);
  const [code] = await once(child, 'exit');
  expect(code).toBe(0);
  expect(readFileSync(marker + '.aborted', 'utf8')).toBe('yes');
  expect(readFileSync(marker + '.cleaned', 'utf8')).toBe('yes');
  expect(job(f.database)).toMatchObject({ state: 'failed', retryEligible: true });
}, 15_000);

it('kills its owned blocking task child on attempt abort before the worker exits, then recovers', async () => {
  const f = await fixture();
  await provider(f);
  const saved = await preserveHandoff(f.input);
  const pidFile = join(f.dir, 'task-pids');
  taskPidFiles.add(pidFile);
  writeFileSync(
    join(f.dir, 'bin/task'),
    `#!${nodeExecutable}\nimport {appendFileSync} from 'node:fs';\nappendFileSync(${JSON.stringify(pidFile)}, process.pid + '\\n');\nprocess.on('SIGTERM',()=>{}); setInterval(()=>{},1000);`,
    { mode: 0o700 },
  );
  const child = spawn(
    nodeExecutable,
    [
      fileURLToPath(new URL('./fixtures/capture-worker-hang.mjs', import.meta.url)),
      hostEntry,
      f.database,
      f.inbox,
    ],
    { env: { ...isolatedEnv(f), CAPTURE_HANG_STAGE: 'task' }, stdio: 'ignore' },
  );
  children.add(child);
  await waitFor(() => existsSync(pidFile));
  const [code] = await once(child, 'exit');
  expect(code).toBe(0);
  for (const pid of readFileSync(pidFile, 'utf8').trim().split('\n').map(Number)) {
    expect(() => process.kill(pid, 0)).toThrow();
  }
  expect(job(f.database)).toMatchObject({ state: 'failed', retryEligible: true });
  expect(existsSync(saved.manifest.snapshot)).toBe(true);
  makeDue(f.database);
  await runCaptureWorker({ ...f, review: emptyReview });
  expect(job(f.database)?.state).toBe('completed');
}, 15_000);

it('drains two projects from a third cwd with identical stored-auth commands and fresh provider/model/override headers', async () => {
  const a = await fixture();
  const b = await fixture();
  const c = await fixture();
  c.database = b.database;
  c.inbox = c.input.inbox = b.inbox;
  c.input.id = 'second';
  c.input.source.sessionId = 'other';
  writeFileSync(
    c.input.source.file,
    readFileSync(c.input.source.file, 'utf8').replace('"id":"saved"', '"id":"other"'),
  );
  const providers = [];
  for (const [label, f] of [
    ['B', b],
    ['C', c],
  ] as const) {
    providers.push(await provider(f));
    for (const kind of ['credential', 'header', 'model-header', 'override-header']) {
      writeFileSync(
        join(f.dir, kind),
        `#!${nodeExecutable}\nimport {writeFileSync} from 'node:fs'; writeFileSync('${kind}-cwd', process.cwd()); process.stdout.write('${kind}-${label}');`,
        { mode: 0o700 },
      );
    }
    writeFileSync(
      join(f.agentDir, 'auth.json'),
      record({ offline: { type: 'api_key', key: '!./credential' } }),
    );
    f.input.execution.runtime.headerNames = ['X-Command', 'X-Model', 'X-Override', 'X-Worker-Pid'];
    writeFileSync(
      join(f.agentDir, 'models.json'),
      record({
        providers: {
          offline: {
            api: 'openai-completions',
            baseUrl: f.input.execution.runtime.model.baseUrl,
            headers: { 'X-Command': '!./header', 'X-Worker-Pid': '!printf "$PPID"' },
            models: [
              { ...f.input.execution.runtime.model, headers: { 'X-Model': '!./model-header' } },
            ],
            modelOverrides: {
              'not-in-catalog': { headers: { 'X-Override': '!./override-header' } },
            },
          },
        },
      }),
    );
    writeFileSync(
      join(f.dir, 'bin/task'),
      `#!${nodeExecutable}\nimport {writeFileSync} from 'node:fs'; if(!process.argv.includes('export'))process.exit(1); writeFileSync('task-cwd', process.cwd()); process.stdout.write('[]');`,
      { mode: 0o700 },
    );
    await preserveHandoff(f.input);
  }
  const child = spawn(nodeExecutable, [bootstrap, hostEntry, b.database, b.inbox], {
    cwd: a.dir,
    env: { ...isolatedEnv(a), PATH: join(b.dir, 'bin') + ':' + dirname(nodeExecutable) },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  children.add(child);
  let stderr = '';
  child.stderr!.on('data', (chunk) => {
    stderr += String(chunk);
  });
  const [code] = await once(child, 'exit');
  expect(code, stderr).toBe(0);
  expect(job(b.database)?.state).toBe('completed');
  expect(job(b.database, 'second')?.state).toBe('completed');
  for (const [index, label, f] of [
    [0, 'B', b],
    [1, 'C', c],
  ] as const) {
    const requests = providers[index]!.requests;
    const work = requests.map(({ body }) =>
      stepWork(providerInstruction(body['messages'] as { role: string; content: string }[])),
    );
    expect(work.filter((step) => step.range)).toHaveLength(1);
    if (index === 1) expect(work.some((step) => step.catalogue?.[0]?.handle)).toBe(true);
    for (const { headers } of requests) {
      expect(headers['authorization']).toBe(`Bearer credential-${label}`);
      expect(headers['x-command']).toBe(`header-${label}`);
      expect(headers['x-model']).toBe(`model-header-${label}`);
      expect(headers['x-override']).toBe(`override-header-${label}`);
    }
    for (const kind of ['credential', 'header', 'model-header', 'override-header', 'task'])
      expect(readFileSync(join(f.dir, kind + '-cwd'), 'utf8')).toBe(realpathSync(f.dir));
  }
  expect(providers[0]!.requests[0]!.headers['x-worker-pid']).toBe(
    providers[1]!.requests[0]!.headers['x-worker-pid'],
  );
}, 30_000);

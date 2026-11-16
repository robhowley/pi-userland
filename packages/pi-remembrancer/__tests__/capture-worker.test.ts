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
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, expect, it, vi } from 'vitest';
import * as handoffs from '../extensions/remembrancer/capture-handoff.js';
import * as notices from '../extensions/remembrancer/capture-notices.js';
import { CheckpointStore } from '../extensions/remembrancer/checkpoints.js';
import { preserveHandoff, type HandoffInput } from '../extensions/remembrancer/capture-handoff.js';
import {
  launchCaptureWorker,
  runCaptureWorker,
} from '../extensions/remembrancer/capture-worker.js';
import type { reviewPreparedCapture } from '../extensions/remembrancer/capture.js';
import { readProposalNotice } from '../extensions/remembrancer/capture-notices.js';

const dirs: string[] = [];
const children = new Set<ChildProcess>();
const workerPids = new Set<number>();
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
  }
  workerPids.clear();
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
const emptyReview: typeof reviewPreparedCapture = async (
  current,
  _store,
  _input,
  check,
  validate,
) => {
  readAll(current);
  check();
  validate([]);
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
async function waitFor(predicate: () => boolean, ms = 15_000) {
  const end = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > end)
      throw Error(
        'Timed out waiting for worker: ' +
          dirs
            .map((dir) =>
              existsSync(join(dir, 'db.sqlite.capture.log'))
                ? readFileSync(join(dir, 'db.sqlite.capture.log'), 'utf8')
                : '',
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

it('drains accepted work without rechecking capture-off, retries at most twice per run, retaining evidence', async () => {
  const f = await fixture();
  const handoff = await preserveHandoff(f.input);
  writeFileSync(
    join(f.agentDir, 'settings.json'),
    record({ 'pi-remembrancer': { disabled: true, autoCapture: false } }),
  );
  const review = vi
    .fn<typeof reviewPreparedCapture>()
    .mockRejectedValue(Error('provider unavailable'));
  await runCaptureWorker({ ...f, review });
  expect(review).toHaveBeenCalledTimes(2);
  expect(job(f.database)).toMatchObject({ state: 'failed', retryEligible: true });
  expect(existsSync(handoff.manifest.snapshot)).toBe(true);
  expect(await readProposalNotice(f.database)).toEqual({ generation: 0, pending: 0 });
  await runCaptureWorker({ ...f, review: emptyReview });
  expect(job(f.database)?.state).toBe('completed');
  expect(existsSync(handoff.manifest.snapshot)).toBe(false);
  expect(await readProposalNotice(f.database)).toEqual({ generation: 0, pending: 0 });
  // Already-covered work also produces no proposal notice.
  await preserveHandoff({ ...f.input, id: 'covered' });
  await runCaptureWorker({ ...f, review });
  expect(review).toHaveBeenCalledTimes(2);
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
  expect(job(f.database)?.state).toBe('completed');
  manual.close();
});

it('releases and rechecks handoffs, reacquires fresh authority, and fences old callbacks', async () => {
  const f = await fixture();
  await preserveHandoff(f.input);
  let oldCheck: (() => void) | undefined;
  let latePage: (() => unknown) | undefined;
  let released = false;
  const calls: string[] = [];
  await runCaptureWorker({
    ...f,
    review: async (...args) => {
      calls.push(args[2].sessionId);
      if (!oldCheck) {
        oldCheck = args[3];
        latePage = () => args[0].page();
      } else {
        expect(oldCheck).toThrow();
        expect(latePage).toThrow();
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
  expect(attempts).toHaveLength(2);
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

async function provider(f: Awaited<ReturnType<typeof fixture>>, empty = false) {
  const requests: { body: Record<string, unknown>; headers: Record<string, unknown> }[] = [];
  let block = false;
  const blocked = new Set<() => void>();
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    requests.push({ body, headers: req.headers });
    const pid = Number(req.headers['x-worker-pid']);
    if (Number.isSafeInteger(pid) && pid > 1) workerPids.add(pid);
    if (block) await new Promise<void>((r) => blocked.add(r));
    const messages = body.messages as {
      role: string;
      tool_calls?: { function: { name: string } }[];
    }[];
    const names = messages.flatMap((m) => m.tool_calls?.map((c) => c.function.name) ?? []);
    const name = !names.includes('remembrancer_read_evidence')
      ? 'remembrancer_read_evidence'
      : !names.includes('remembrancer_tasks')
        ? 'remembrancer_tasks'
        : !names.includes('remembrancer_proposals')
          ? 'remembrancer_proposals'
          : 'remembrancer_submit';
    const args =
      name === 'remembrancer_submit'
        ? {
            proposals: empty
              ? []
              : [
                  {
                    change: {
                      operation: 'add',
                      fields: { description: 'Send comparison' },
                      annotations: [],
                    },
                    expected: null,
                    question: null,
                    explanation: 'Explicit promise',
                    references: [
                      {
                        sessionId: 'saved',
                        branchId: 'promise',
                        entryId: 'promise',
                        editId: null,
                        offset: 0,
                        quote: 'Send Maya',
                      },
                    ],
                  },
                ],
          }
        : {};
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const chunk = (delta: unknown, finish_reason: string | null = null) =>
      `data: ${JSON.stringify({ id: 'response', object: 'chat.completion.chunk', created: 1, model: 'not-in-catalog', choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
    res.end(
      chunk({
        role: 'assistant',
        tool_calls: [
          {
            index: 0,
            id: `call_${name}`,
            type: 'function',
            function: { name, arguments: JSON.stringify(args) },
          },
        ],
      }) +
        chunk({}, 'tool_calls') +
        'data: [DONE]\n\n',
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
    expect(p.requests).toHaveLength(crash ? 5 : 8);
    expect(p.requests[0]!.body['model']).toBe('not-in-catalog');
    expect(p.requests[0]!.body['reasoning_effort']).toBe('high');
    expect(p.requests[0]!.headers['authorization']).toBe('Bearer fixture-key');
    expect(p.requests[0]!.headers['x-command']).toBe('command-header');
    expect(existsSync(join(f.dir, 'auth-outside-lock'))).toBe(true);
    expect(existsSync(join(f.dir, 'tasks-outside-lock'))).toBe(true);
    const tools = p.requests[0]!.body['tools'] as { function: { name: string } }[];
    expect(tools.map((t) => t.function.name)).toEqual([
      'remembrancer_read_evidence',
      'remembrancer_context',
      'remembrancer_tasks',
      'remembrancer_proposals',
      'remembrancer_submit',
    ]);
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
  expect(job(f.database)?.state).toBe('completed');
}, 25_000);

it('rejects synchronous reviewer output after absolute expiry before timers can run', async () => {
  const f = await fixture();
  const saved = await preserveHandoff(f.input);
  let deadlineRejections = 0;
  let validationRejections = 0;
  let earlyAborts = 0;
  await runCaptureWorker({
    ...f,
    budgetMs: 25,
    review: async (current, _db, input, check, validate) => {
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
        validate([]);
      } catch {
        validationRejections++;
      }
      return [];
    },
  });
  expect(earlyAborts).toBe(0);
  expect(deadlineRejections).toBe(2);
  expect(validationRejections).toBe(2);
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
  expect(cleanupCwds).toEqual([realpathSync(f.dir), realpathSync(f.dir)]);
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

it.each(['notice', 'snapshot'] as const)(
  'repairs completed rows after %s failure without ready signals or reviewer replay',
  async (failure) => {
    const f = await fixture();
    const saved = await preserveHandoff(f.input);
    const cleanup = vi.spyOn(handoffs, 'cleanupCompletedSnapshot');
    const notice = vi.spyOn(notices, 'publishProposalNotice');
    // Fail all cleanup in the first drain, not the database completion.
    cleanup.mockRejectedValue(
      Object.assign(Error('credential-provider-body-command'), { code: 'EACCES' }),
    );
    if (failure === 'notice')
      notice.mockRejectedValue(
        Object.assign(Error('credential-provider-body-command'), { code: 'ENOSPC' }),
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
    notice.mockRestore();
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
    if (failure === 'notice') expect(log).toContain('ENOSPC');
    expect(log).not.toContain('credential-provider-body-command');
    expect(log).not.toContain('contention');
  },
);

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
    providers.push(await provider(f, true));
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
    expect(requests).toHaveLength(4);
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

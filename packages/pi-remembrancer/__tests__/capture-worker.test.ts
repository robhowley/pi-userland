import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import { CheckpointStore } from '../extensions/remembrancer/checkpoints.js';
import { preserveHandoff, type HandoffInput } from '../extensions/remembrancer/capture-handoff.js';
import {
  launchCaptureWorker,
  runCaptureWorker,
} from '../extensions/remembrancer/capture-worker.js';
import type { reviewPreparedCapture } from '../extensions/remembrancer/capture.js';

const dirs: string[] = [];
const children = new Set<ChildProcess>();
const servers: Server[] = [];
afterEach(async () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
    }
  }
  children.clear();
  for (const dir of dirs) {
    const pidFile = join(dir, 'worker.pid');
    if (existsSync(pidFile)) {
      try {
        process.kill(Number(readFileSync(pidFile, 'utf8')), 'SIGKILL');
      } catch {
        /* already exited */
      }
    }
  }
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
      trustBasis: 'temporary-context-trust',
      model: { provider: 'offline', id: 'not-in-catalog' },
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
  await runCaptureWorker({ ...f, review: emptyReview });
  expect(job(f.database)?.state).toBe('completed');
  expect(existsSync(handoff.manifest.snapshot)).toBe(false);
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
  await provider(f);
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
  await preserveHandoff(f.input);
  let calls = 0;
  await runCaptureWorker({
    ...f,
    budgetMs: 10,
    graceMs: 200,
    review: async (current, _db, _input, check) => {
      calls++;
      readAll(current);
      await new Promise((r) => setTimeout(r, 25));
      expect(check).toThrow();
      return [];
    },
  });
  expect(calls).toBe(2);
  expect(job(f.database)?.state).toBe('failed');
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

it.skipIf(process.platform === 'win32')(
  'does not promise descendant termination: an ordinary POSIX child survives worker self-exit',
  async () => {
    const f = await fixture();
    await preserveHandoff(f.input);
    const pidFile = join(f.dir, 'descendant-pid');
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
          CAPTURE_HANG_STAGE: 'setup',
          CAPTURE_HANG_MARKER: join(f.dir, 'marker'),
          CAPTURE_DESCENDANT_PID: pidFile,
        },
        stdio: 'ignore',
      },
    );
    children.add(child);
    let pid: number | undefined;
    try {
      const [code] = await once(child, 'exit');
      expect(code).toBe(1);
      pid = Number(readFileSync(pidFile, 'utf8'));
      expect(() => process.kill(pid!, 0)).not.toThrow();
    } finally {
      if (pid) process.kill(pid, 'SIGKILL');
    }
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

async function provider(f: Awaited<ReturnType<typeof fixture>>) {
  const requests: { body: Record<string, unknown>; headers: Record<string, unknown> }[] = [];
  let block = false;
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    requests.push({ body, headers: req.headers });
    if (block) return;
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
            proposals: [
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
  f.input.execution.runtime!.headerNames = ['X-Command'];
  writeFileSync(
    join(f.agentDir, 'models.json'),
    record({
      providers: {
        offline: {
          api: 'openai-completions',
          baseUrl: f.input.execution.runtime!.model.baseUrl,
          headers: { 'X-Command': '!printf command-header' },
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
  };
}

it('uses the actual host SDK, supplied absent-catalog model and command credentials, survives immediate parent exit, and runs relocated', async () => {
  const f = await fixture();
  const p = await provider(f);
  await preserveHandoff(f.input);
  // Real publication file list, unpacked outside the repository without dependencies.
  const installed = join(f.dir, 'installed');
  mkdirSync(installed);
  const packEnv = {
    ...isolatedEnv(f),
    PATH: process.env['PATH'],
    npm_config_cache: join(f.dir, 'npm-cache'),
  };
  const packed = JSON.parse(
    execFileSync('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', installed], {
      cwd: resolve('.'),
      env: packEnv,
      encoding: 'utf8',
    }),
  ) as { filename: string }[];
  execFileSync('tar', ['-xzf', join(installed, packed[0]!.filename), '-C', installed], {
    env: packEnv,
  });
  const relocated = join(installed, 'package');
  expect(existsSync(join(relocated, 'node_modules'))).toBe(false);
  const entry = join(relocated, 'extensions/remembrancer/capture-worker.ts');
  // A short-lived parent calls the actual launch API, then exits immediately.
  const parent = join(f.dir, 'parent.mjs');
  writeFileSync(
    parent,
    `import {createRequire} from 'node:module';
    import {writeFileSync} from 'node:fs';
    const host=createRequire(${JSON.stringify(hostEntry)});
    const {createJiti}=host('jiti');
    const jiti=createJiti(import.meta.url,{interopDefault:true,alias:{
      '@earendil-works/pi-coding-agent':${JSON.stringify(join(dirname(hostEntry), 'index.js'))},
      '@sinclair/typebox':host.resolve('typebox')
    }});
    const {launchCaptureWorker}=await jiti.import(${JSON.stringify(entry)});
    const pid=await launchCaptureWorker(${JSON.stringify(f.database)},${JSON.stringify(f.inbox)},${JSON.stringify(f.input.execution.host)});
    writeFileSync(${JSON.stringify(join(f.dir, 'worker.pid'))},String(pid));`,
  );
  const child = spawn(nodeExecutable, [parent], { env: isolatedEnv(f), stdio: 'ignore' });
  children.add(child);
  const [code] = await once(child, 'exit');
  expect(code).toBe(0);
  await waitFor(() => job(f.database)?.state === 'completed');
  const workerPid = Number(readFileSync(join(f.dir, 'worker.pid'), 'utf8'));
  await waitFor(() => {
    try {
      process.kill(workerPid, 0);
      return false;
    } catch {
      return true;
    }
  });
  expect(p.requests).toHaveLength(4);
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
}, 25_000);

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

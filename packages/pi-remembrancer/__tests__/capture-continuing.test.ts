import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { AgentSession, ModelRuntime } from '@earendil-works/pi-coding-agent';
import { afterEach, expect, it, vi } from 'vitest';
import {
  CaptureArtifacts,
  REMEMBRANCER_SKILL_PATH,
} from '../extensions/remembrancer/capture-artifacts.js';
import { CaptureReview } from '../extensions/remembrancer/capture-review.js';
import { reviewPreparedCapture } from '../extensions/remembrancer/capture.js';
import {
  validateCaptureSubmission,
  type CaptureSubmission,
} from '../extensions/remembrancer/capture-submission.js';
import { CheckpointStore } from '../extensions/remembrancer/checkpoints.js';
import { prepareReview } from '../extensions/remembrancer/evidence.js';
import { readTaskCatalog, snapshot } from '../extensions/remembrancer/taskwarrior.js';
import type { Proposal, ProposalSubmission } from '../extensions/remembrancer/proposals.js';
import { buildOpeningPrompt } from '../extensions/remembrancer/reviewer.js';
import { writeCompletion } from './fixtures/openai-loopback.js';
import { captureJob } from './fixtures/capture-job.js';
import { captureToolCalls, reviewerPaths } from './fixtures/capture-reviewer.js';

vi.mock('../extensions/remembrancer/taskwarrior.js', async (original) => ({
  ...(await original<typeof import('../extensions/remembrancer/taskwarrior.js')>()),
  readTaskCatalog: vi.fn().mockResolvedValue([]),
}));
vi.mock('node:fs', async (original) => ({
  ...(await original<typeof import('node:fs')>()),
  unlinkSync: vi.fn((await original<typeof import('node:fs')>()).unlinkSync),
  mkdtempSync: vi.fn((await original<typeof import('node:fs')>()).mkdtempSync),
}));
const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs');
const dirs: string[] = [];
afterEach(() => {
  vi.mocked(unlinkSync).mockImplementation(actualFs.unlinkSync);
  vi.mocked(readTaskCatalog).mockReset().mockResolvedValue([]);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function fixture(text = 'I will send Maya the comparison.', preceding: string[] = []) {
  const dir = mkdtempSync(join(tmpdir(), 'capture-continuing-'));
  dirs.push(dir);
  const source = { sessionId: 'session', file: join(dir, 'session.jsonl') };
  writeFileSync(
    source.file,
    [
      { type: 'session', id: 'session', cwd: dir },
      ...preceding.map((text, index) => ({
        type: 'message',
        id: `older-${index}`,
        parentId: index ? `older-${index - 1}` : null,
        timestamp: '2026-01-01',
        message: { role: 'user', content: text },
      })),
      {
        type: 'message',
        id: 'entry',
        parentId: preceding.length ? `older-${preceding.length - 1}` : null,
        timestamp: '2026-01-30',
        message: { role: 'user', content: text },
      },
    ]
      .map((entry) => JSON.stringify(entry))
      .join('\n') + '\n',
  );
  const review = prepareReview(
    [source],
    [],
    preceding.length ? { requestedSince: '2026-01-29' } : undefined,
  );
  const current = new CaptureReview(review, () => {});
  const ref = {
    sessionId: 'session',
    branchId: 'entry',
    entryId: 'entry',
    editId: null,
    offset: 0,
    quote: text,
  };
  const change = {
    operation: 'add' as const,
    fields: { description: 'Send Maya the comparison.' },
    annotations: [],
  };
  const payload: CaptureSubmission = {
    records: [
      {
        key: 'maya',
        observations: [{ kind: 'accepted', reference: ref }],
        states: [
          {
            branchId: ref.branchId,
            state: {
              summary: 'Accepted comparison',
              status: 'active',
              draft: { change, question: null },
            },
          },
        ],
        ambiguous: false,
        candidates: [],
      },
    ],
    dispositions: [
      {
        records: ['maya'],
        reason: 'Accepted',
        submission: { change, question: null, explanation: 'User promised the comparison.' },
      },
    ],
  };
  return { dir, current, payload, review, source };
}
function delivered(current: CaptureReview) {
  for (const page of current.preparePages()) page.accept();
}
const task = {
  uuid: '12345678-1234-1234-1234-123456789abc',
  status: 'pending',
  description: 'Send Maya the comparison.',
  annotations: [],
};
function proposal(state: Proposal['state'] = 'pending'): Proposal {
  return {
    id: 'saved',
    revision: 2,
    state,
    change: {
      operation: 'add',
      fields: { description: 'Send Maya the comparison.' },
      annotations: [],
    },
    expected: null,
    question: null,
    explanation: 'Saved',
    sources: [],
    draft: null,
    claim: null,
    result: null,
    createdAt: '2026-01-01',
    updatedAt: '2026-01-01',
  };
}

it('validates final content unchanged and accepts empty records only after delivery', () => {
  const { current, payload } = fixture();
  expect(() =>
    validateCaptureSubmission({ records: [], dispositions: [] }, current, [], []),
  ).toThrow('Read all evidence');
  delivered(current);
  const result = validateCaptureSubmission(payload, current, [], []);
  expect(result[0]).toEqual({
    ...payload.dispositions[0]!.submission,
    expected: null,
    references: [payload.records[0]!.observations[0]!.reference],
  });
  expect(validateCaptureSubmission({ records: [], dispositions: [] }, current, [], [])).toEqual([]);
});

it.each(['source', 'group', 'duplicate', 'snapshot', 'target', 'question', 'candidate-revision'])(
  'rejects invalid finalized %s without completing model content',
  (defect) => {
    const { current, payload } = fixture();
    delivered(current);
    if (defect === 'source')
      payload.records[0]!.observations[0]!.reference.quote = 'supporting-only text';
    if (defect === 'group') payload.dispositions[0]!.records = ['unknown'];
    if (defect === 'duplicate') payload.dispositions.push(payload.dispositions[0]!);
    if (defect === 'snapshot')
      Object.assign(payload.dispositions[0]!.submission!, { expected: snapshot(task) });
    if (defect === 'target')
      payload.dispositions[0]!.submission!.change = {
        operation: 'complete',
        targetUuid: task.uuid,
        annotations: [],
      };
    if (defect === 'question')
      payload.records[0]!.states[0]!.state.draft!.question = 'Which comparison?';
    if (defect === 'candidate-revision')
      payload.records[0]!.candidates.push({
        kind: 'proposal',
        id: 'saved',
        revision: 1,
        judgment: 'same',
      });
    expect(() => validateCaptureSubmission(payload, current, [task], [proposal()])).toThrow();
  },
);

it('binds pending proposal revision and trusted task snapshot, never model identity', () => {
  const { current, payload } = fixture();
  delivered(current);
  const saved = proposal();
  saved.change = {
    operation: 'update',
    targetUuid: task.uuid,
    fields: { due: '20261201T000000Z' },
    annotations: [],
  };
  saved.expected = snapshot(task);
  const change = {
    operation: 'update' as const,
    targetUuid: task.uuid,
    fields: { due: '20261202T000000Z' },
    annotations: [],
  };
  payload.records[0]!.states[0]!.state.draft!.change = change;
  payload.records[0]!.candidates = [
    { kind: 'task', id: task.uuid, judgment: 'same' },
    { kind: 'proposal', id: saved.id, revision: 2, judgment: 'same' },
  ];
  payload.dispositions[0]!.submission!.change = change;
  expect(validateCaptureSubmission(payload, current, [task], [saved])[0]).toMatchObject({
    id: 'saved',
    expectedRevision: 2,
    expected: snapshot(task),
    change,
  });
});

it.each(['applying', 'uncertain'] as const)(
  'allows %s recovery only for host-proved satisfaction and null',
  (state) => {
    const { current, payload } = fixture();
    delivered(current);
    const saved = proposal(state);
    saved.change = {
      operation: 'update',
      targetUuid: task.uuid,
      fields: { description: task.description },
      annotations: [],
    };
    saved.expected = snapshot(task);
    payload.records[0]!.candidates = [
      { kind: 'task', id: task.uuid, judgment: 'same' },
      { kind: 'proposal', id: saved.id, revision: 2, judgment: 'same' },
    ];
    expect(() => validateCaptureSubmission(payload, current, [task], [saved])).toThrow(
      'verify-only',
    );
    payload.dispositions[0]!.submission = null;
    expect(validateCaptureSubmission(payload, current, [task], [saved])).toEqual([]);
    expect(() =>
      validateCaptureSubmission(
        payload,
        current,
        [{ ...task, description: 'Other task' }],
        [saved],
      ),
    ).toThrow('verify-only');
  },
);

it.each(['records', 'branches'] as const)(
  'preserves a known task for conflicting %s, requiring a question without allowing an add',
  (grouping) => {
    const f = fixture();
    writeFileSync(
      f.source.file,
      readFileSync(f.source.file, 'utf8') +
        JSON.stringify({
          type: 'message',
          id: 'sibling',
          parentId: null,
          timestamp: '2026-01-30',
          message: { role: 'user', content: 'I will send Maya the comparison.' },
        }) +
        '\n',
    );
    const current = new CaptureReview(prepareReview([f.source], []), () => {});
    delivered(current);
    const payload = f.payload;
    const change = {
      operation: 'update' as const,
      targetUuid: task.uuid,
      fields: { due: '20261201T000000Z' },
      annotations: [],
    };
    const first = payload.records[0]!;
    first.states[0]!.state.draft!.change = change;
    first.candidates = [{ kind: 'task', id: task.uuid, judgment: 'same' }];
    const second = structuredClone(first);
    second.key = 'sibling';
    second.observations[0]!.reference.branchId = 'sibling';
    second.observations[0]!.reference.entryId = 'sibling';
    second.states[0]!.branchId = 'sibling';
    second.states[0]!.state.draft!.change = { ...change, fields: { due: '20261202T000000Z' } };
    if (grouping === 'records') payload.records.push(second);
    else {
      first.observations.push(...second.observations);
      first.states.push(...second.states);
    }
    const submission = {
      change,
      question: 'December 1 or December 2?',
      explanation: 'Branches request different dates.',
    };
    payload.dispositions = [
      {
        records: payload.records.map((record) => record.key),
        reason: 'Same known task, conflicting dates',
        submission,
      },
    ];
    expect(validateCaptureSubmission(payload, current, [task], [])[0]).toEqual({
      ...submission,
      expected: snapshot(task),
      references: payload.records.flatMap((record) =>
        record.observations.map((item) => item.reference),
      ),
    });
    payload.dispositions[0]!.submission = { ...submission, question: null };
    expect(() => validateCaptureSubmission(payload, current, [task], [])).toThrow(
      'requires a question',
    );
    payload.dispositions[0]!.submission = null;
    expect(() => validateCaptureSubmission(payload, current, [task], [])).toThrow(
      'requires a question',
    );
    payload.dispositions[0]!.submission = {
      ...submission,
      change: {
        operation: 'add',
        fields: { description: 'Duplicate comparison' },
        annotations: [],
      },
    };
    expect(() => validateCaptureSubmission(payload, current, [task], [])).toThrow(
      'cannot become an addition',
    );
    first.ambiguous = true;
    payload.dispositions = [{ records: [first.key], reason: 'Identity unclear', submission }];
    if (grouping === 'records') payload.records = [first];
    expect(() => validateCaptureSubmission(payload, current, [task], [])).toThrow(
      'not uniquely matched',
    );
  },
);

it('rejects an applied-add match when its verified task is missing', () => {
  const { current, payload } = fixture();
  delivered(current);
  const saved = proposal('applied');
  saved.result = { state: 'applied', verified: snapshot(task), error: null };
  payload.records[0]!.candidates = [
    { kind: 'proposal', id: saved.id, revision: 2, judgment: 'same' },
  ];
  expect(() => validateCaptureSubmission(payload, current, [], [saved])).toThrow('no live task');
});

it('checks reviewer-selected consolidation instead of regrouping colliding records', () => {
  const { current, payload } = fixture();
  delivered(current);
  const second = structuredClone(payload.records[0]!);
  second.key = 'other';
  payload.records[0]!.candidates = second.candidates = [
    { kind: 'task', id: task.uuid, judgment: 'same' },
  ];
  payload.records.push(second);
  payload.dispositions.push({ ...payload.dispositions[0]!, records: ['other'] });
  expect(() => validateCaptureSubmission(payload, current, [task], [])).toThrow(
    'definite identities',
  );
  payload.dispositions = [{ records: ['maya', 'other'], reason: 'Same task', submission: null }];
  expect(validateCaptureSubmission(payload, current, [task], [])).toEqual([]);
});

function messageText(content: unknown): string {
  return typeof content === 'string'
    ? content
    : (content as { text?: string }[]).map((part) => part.text ?? '').join('');
}

async function withSdk(
  decide: (
    turn: number,
    paths: { skill: string; review: string },
    evidenceFixture: ReturnType<typeof fixture>,
    request: Record<string, unknown>,
  ) => { name: string; args: object }[] | string,
  check: (
    run: Promise<unknown>,
    context: {
      requests: Record<string, unknown>[];
      current: CaptureReview;
      paths: { skill: string; review: string };
      db: CheckpointStore;
      publish: (submissions: readonly ProposalSubmission[]) => Proposal[];
      jobId: string | undefined;
    },
  ) => Promise<void>,
  options: {
    text?: string;
    preceding?: string[];
    durable?: boolean;
    contextWindow?: number;
    signal?: AbortSignal;
    afterRequest?: (turn: number) => void;
    beforeReview?: (db: CheckpointStore) => void;
  } = {},
) {
  const f = fixture(options.text, options.preceding);
  const agentDir = join(f.dir, 'agent');
  mkdirSync(agentDir);
  writeFileSync(join(f.dir, 'AGENTS.md'), 'FORBIDDEN_AUTOLOAD');
  mkdirSync(join(agentDir, 'extensions'));
  writeFileSync(
    join(agentDir, 'extensions', 'forbidden.ts'),
    'throw new Error("FORBIDDEN_AUTOLOAD");',
  );
  const paths = { skill: '', review: '' };
  const requests: Record<string, unknown>[] = [];
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    const parsed = JSON.parse(body);
    requests.push(parsed);
    const messages = parsed.messages as { role: string; content: string }[];
    const prompt = messageText(messages.find((item) => item.role === 'user')!.content);
    Object.assign(paths, reviewerPaths(prompt));
    options.afterRequest?.(requests.length);
    const calls = decide(requests.length, paths, f, parsed);
    if (typeof calls === 'string')
      writeCompletion(response, { role: 'assistant', content: calls }, 'stop');
    else writeCompletion(response, captureToolCalls(calls, requests.length), 'tool_calls');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const db = new CheckpointStore(join(f.dir, 'index.sqlite'));
  const capture = options.durable ? captureJob(db, f.source) : undefined;
  if (capture) f.current = capture.review;
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No fixture port');
    writeFileSync(
      join(agentDir, 'models.json'),
      JSON.stringify({
        providers: {
          fixture: {
            api: 'openai-completions',
            baseUrl: `http://127.0.0.1:${address.port}/v1`,
            apiKey: 'offline',
            models: [
              {
                id: 'fixture',
                name: 'Fixture',
                reasoning: false,
                input: ['text'],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: options.contextWindow ?? 200_000,
                maxTokens: 4096,
              },
            ],
          },
        },
      }),
    );
    const runtime = await ModelRuntime.create({
      authPath: join(agentDir, 'auth.json'),
      modelsPath: join(agentDir, 'models.json'),
    });
    options.beforeReview?.(db);
    const run = reviewPreparedCapture(
      f.current,
      db,
      {
        cwd: f.dir,
        agentDir,
        modelRuntime: runtime,
        model: runtime.getModel('fixture', 'fixture')!,
        sessionId: 'session',
        ...(options.signal ? { signal: options.signal } : {}),
      },
      () => {},
    );
    await check(run, {
      requests,
      current: f.current,
      paths,
      db,
      publish(submissions) {
        if (!capture) throw new Error('Enable durable fixture to publish');
        return db.finishCaptureJob(capture.owner, capture.attempt, submissions);
      },
      jobId: capture?.manifest.id,
    });
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    if (paths.review) rmSync(dirname(paths.review), { recursive: true, force: true });
    capture?.owner.release();
    db.close();
  }
}
const read = (path: string, page = 0) => [{ name: 'remembrancer_read', args: { path, page } }];

it('creates no generated evidence and saves nothing when the startup database read fails', async () => {
  const dispose = vi.spyOn(AgentSession.prototype, 'dispose');
  try {
    await withSdk(
      () => {
        throw new Error('Reviewer must not start');
      },
      async (run, { requests, current, db, publish, jobId }) => {
        const finish = vi.spyOn(db, 'finishCaptureJob');
        try {
          await expect((run as Promise<ProposalSubmission[]>).then(publish)).rejects.toThrow(
            'startup database failure',
          );
          expect(vi.mocked(mkdtempSync)).not.toHaveBeenCalled();
          expect(requests).toEqual([]);
          expect(dispose).not.toHaveBeenCalled();
          expect(() => current.completion([])).toThrow('Read all evidence');
          expect(finish).not.toHaveBeenCalled();
          expect(db.proposals()).toEqual([]);
          expect(db.reviewed()).toEqual([]);
          expect(db.sources()).toEqual([]);
          expect(db.captureJob(jobId!)!.state).toBe('queued');
        } finally {
          finish.mockRestore();
        }
      },
      {
        durable: true,
        beforeReview(db) {
          vi.mocked(mkdtempSync).mockClear();
          vi.spyOn(db, 'contextGeneration').mockImplementationOnce(() => {
            throw new Error('startup database failure');
          });
        },
      },
    );
  } finally {
    dispose.mockRestore();
  }
});

it('uses one real SDK session, exact short prompt, retained tool history, and reviewer-issued final content', async () => {
  await withSdk(
    (turn, paths, f) => {
      if (turn === 1) return read(paths.skill);
      if (turn === 2) return read(paths.review);
      if (turn === 3) return [{ name: 'remembrancer_tasks', args: {} }];
      if (turn === 4) return [{ name: 'remembrancer_proposals', args: {} }];
      return [{ name: 'remembrancer_submit', args: f.payload }];
    },
    async (run, { requests, paths, db }) => {
      const disposal = vi.spyOn(AgentSession.prototype, 'dispose');
      const result = await run;
      expect(disposal).toHaveBeenCalledOnce();
      disposal.mockRestore();
      expect(result).toMatchObject([
        {
          change: { fields: { description: 'Send Maya the comparison.' } },
          explanation: 'User promised the comparison.',
        },
      ]);
      expect(requests).toHaveLength(5);
      expect(vi.mocked(readTaskCatalog)).toHaveBeenCalledOnce();
      const first = requests[0]!['messages'] as { role: string; content: string }[];
      expect(messageText(first.find((item) => item.role === 'user')!.content)).toBe(
        buildOpeningPrompt(paths.skill, paths.review),
      );
      const last = JSON.stringify(requests.at(-1));
      expect(last).toContain(
        JSON.stringify(readFileSync(REMEMBRANCER_SKILL_PATH, 'utf8').slice(-80)).slice(1, -1),
      );
      expect(last).toContain('I will send Maya the comparison.');
      expect(last).toContain('tool_call_id');
      expect(last).not.toContain('FORBIDDEN_AUTOLOAD');
      expect(
        (requests[0]!['tools'] as { function: { name: string } }[]).map(
          (item) => item.function.name,
        ),
      ).toEqual([
        'remembrancer_read',
        'remembrancer_context',
        'remembrancer_tasks',
        'remembrancer_proposals',
        'remembrancer_submit',
      ]);
      expect(existsSync(dirname(paths.review))).toBe(false);
      expect(existsSync(paths.skill)).toBe(true);
      expect(db.proposals()).toEqual([]); // Staging is not durable publication.
    },
  );
});

it('publishes reviewer-issued intent only after SDK disposal and artifact cleanup, with host bindings', async () => {
  vi.mocked(readTaskCatalog).mockResolvedValue([task]);
  const intent = {
    change: {
      operation: 'update' as const,
      targetUuid: task.uuid,
      fields: { due: '20261202T000000Z' },
      annotations: ['Requested date'],
    },
    question: 'Keep December 2?',
    explanation: 'Reviewer chose this exact wording.',
  };
  await withSdk(
    (turn, paths, f) => {
      if (turn === 1) return read(paths.skill);
      if (turn === 2) return read(paths.review);
      if (turn === 3) return [{ name: 'remembrancer_tasks', args: { uuid: task.uuid } }];
      f.payload.records[0]!.states[0]!.state.draft = {
        change: intent.change,
        question: intent.question,
      };
      f.payload.records[0]!.candidates = [{ kind: 'task', id: task.uuid, judgment: 'same' }];
      f.payload.dispositions[0]!.submission = intent;
      return [{ name: 'remembrancer_submit', args: f.payload }];
    },
    async (run, { db, paths, publish, jobId }) => {
      const dispose = vi.spyOn(AgentSession.prototype, 'dispose');
      try {
        const staged = (await run) as ProposalSubmission[];
        expect(dispose).toHaveBeenCalledOnce();
        expect(existsSync(dirname(paths.review))).toBe(false);
        expect(existsSync(paths.skill)).toBe(true);
        expect(db.proposals()).toEqual([]);
        expect(db.reviewed()).toEqual([]);
        expect(db.captureJob(jobId!)!.state).toBe('queued');
        const [saved] = publish(staged);
        expect(saved).toMatchObject({
          ...intent,
          expected: snapshot(task),
          revision: 1,
          state: 'pending',
        });
        expect(saved!.id).toBeTruthy();
        expect(saved!.sources).toEqual([
          {
            ...staged[0]!.references[0],
            file: db.captureJob(jobId!)!.manifest.source.file,
            role: 'user',
            timestamp: '2026-01-30',
            locator: 'session/entry/entry',
          },
        ]);
        expect(db.proposal(saved!.id)).toEqual(saved);
        expect(db.reviewed()).toHaveLength(1);
        expect(db.captureJob(jobId!)!.state).toBe('completed');
        expect(vi.mocked(readTaskCatalog)).toHaveBeenCalledOnce();
      } finally {
        dispose.mockRestore();
      }
    },
    { durable: true },
  );
});

it.each(['cleanup', 'conflicting-add', 'transaction'] as const)(
  'saves neither proposals nor coverage when %s prevents publication',
  async (failure) => {
    if (failure === 'conflicting-add') vi.mocked(readTaskCatalog).mockResolvedValue([task]);
    await withSdk(
      (turn, paths, f) => {
        if (turn === 1) return read(paths.skill);
        if (turn === 2) return read(paths.review);
        if (failure === 'conflicting-add' && turn === 3)
          return [{ name: 'remembrancer_tasks', args: { uuid: task.uuid } }];
        if (failure === 'cleanup')
          vi.mocked(unlinkSync).mockImplementation(() => {
            throw new Error('fixture cleanup failure');
          });
        if (failure === 'conflicting-add') {
          const first = f.payload.records[0]!;
          first.candidates = [{ kind: 'task', id: task.uuid, judgment: 'same' }];
          first.states[0]!.state.draft!.change = {
            operation: 'update',
            targetUuid: task.uuid,
            fields: { due: '20261201' },
            annotations: [],
          };
          const second = structuredClone(first);
          second.key = 'other-date';
          second.states[0]!.state.draft!.change = {
            operation: 'update',
            targetUuid: task.uuid,
            fields: { due: '20261202' },
            annotations: [],
          };
          f.payload.records.push(second);
          f.payload.dispositions[0]!.records.push(second.key);
          f.payload.dispositions[0]!.submission!.question = 'Which date?';
        }
        return [{ name: 'remembrancer_submit', args: f.payload }];
      },
      async (run, { db, publish, jobId }) => {
        if (failure === 'transaction') {
          const sql = new DatabaseSync(db.file);
          sql.exec(
            "CREATE TRIGGER fail_completion BEFORE UPDATE OF state ON capture_jobs WHEN NEW.state = 'completed' BEGIN SELECT RAISE(ABORT, 'fixture transaction failure'); END",
          );
          sql.close();
        }
        const finish = vi.spyOn(db, 'finishCaptureJob');
        try {
          await expect((run as Promise<ProposalSubmission[]>).then(publish)).rejects.toThrow(
            failure === 'cleanup'
              ? 'cleanup failed'
              : failure === 'conflicting-add'
                ? 'cannot become an addition'
                : 'fixture transaction failure',
          );
          expect(finish).toHaveBeenCalledTimes(failure === 'transaction' ? 1 : 0);
          expect(db.proposals()).toEqual([]);
          expect(db.reviewed()).toEqual([]);
          expect(db.sources()).toEqual([]);
          expect(db.captureJob(jobId!)!.state).toBe('queued');
        } finally {
          finish.mockRestore();
        }
      },
      { durable: true },
    );
  },
);

it('pages backward through owned frozen context older than 40 entries, finishing bounded Unicode continuations', async () => {
  const older = [
    'I will send Maya the comparison. 😀'.repeat(2000),
    ...Array.from({ length: 84 }, (_, index) => `Earlier progress ${index}`),
  ];
  const contextText: string[] = [];
  let skip = 0;
  let offset = 0;
  await withSdk(
    (turn, paths, f, request) => {
      if (turn === 1) return read(paths.skill);
      if (turn === 2) return read(paths.review);
      if (turn === 3) writeFileSync(f.source.file, 'Changed after freezing');
      if (turn > 3) {
        const messages = request['messages'] as { role: string; content: string }[];
        const data = JSON.parse(
          messageText(messages.filter((message) => message.role === 'tool').at(-1)!.content),
        );
        expect(data.contextOnly).toBe(true);
        expect(Buffer.byteLength(JSON.stringify(data), 'utf8')).toBeLessThanOrEqual(51_200);
        for (const group of data.groups)
          for (const entry of group.entries) contextText.push(entry.text);
        if (data.nextOffset !== null) offset = data.nextOffset;
        else if (data.nextSkip !== null) {
          skip = data.nextSkip;
          offset = 0;
        } else return [{ name: 'remembrancer_submit', args: { records: [], dispositions: [] } }];
      }
      return [
        {
          name: 'remembrancer_context',
          args: {
            selected: {
              sessionId: 'session',
              branchId: 'entry',
              entryId: 'entry',
              editId: null,
            },
            before: 40,
            skip,
            offset,
          },
        },
      ];
    },
    async (run, { current, requests }) => {
      await expect(run).resolves.toEqual([]);
      expect(contextText.join('')).toContain(older[0]);
      expect(requests.length).toBeGreaterThan(6);
      expect(() =>
        current.context({
          batch: current.id,
          selected: { sessionId: 'session', branchId: 'entry', entryId: 'entry', editId: null },
          skip: 86,
        }),
      ).toThrow('outside');
      const manual = current.context({
        batch: current.id,
        selected: { sessionId: 'session', branchId: 'entry', entryId: 'entry', editId: null },
      });
      expect(manual).not.toHaveProperty('nextSkip');
      expect(() =>
        current.context({
          batch: current.id,
          selected: {
            sessionId: 'session',
            branchId: 'entry',
            entryId: 'older-0',
            editId: null,
          },
          skip: 0,
        }),
      ).toThrow('not in this review batch');
      expect(() =>
        current.validateReferences([
          {
            sessionId: 'session',
            branchId: 'entry',
            entryId: 'older-0',
            editId: null,
            offset: 0,
            quote: 'I will send Maya',
          },
        ]),
      ).toThrow('eligible evidence');
    },
    { text: 'Still working on it.', preceding: older },
  );
});

it.each(['early', 'mixed', 'absent', 'skip', 'lookup-before-skill', 'path'])(
  'fails closed for %s, without delivery or persistence shortcuts',
  async (failure) => {
    await withSdk(
      (turn, paths) => {
        if (failure === 'early')
          return [{ name: 'remembrancer_submit', args: { records: [], dispositions: [] } }];
        if (failure === 'absent') return 'Finished reviewing.';
        if (failure === 'lookup-before-skill') return [{ name: 'remembrancer_tasks', args: {} }];
        if (failure === 'path') return read(dirname(paths.review));
        if (turn === 1) return read(paths.skill);
        if (failure === 'skip') return read(paths.review, 1);
        return [
          { name: 'remembrancer_submit', args: { records: [], dispositions: [] } },
          ...read(paths.review),
        ];
      },
      async (run, { db, current, paths }) => {
        await expect(run).rejects.toThrow();
        expect(() => current.completion([])).toThrow('Read all evidence');
        expect(db.proposals()).toEqual([]);
        expect(existsSync(dirname(paths.review))).toBe(false);
      },
    );
  },
);

it('accepts empty reports after complete delivery, without requiring a matching catalogue scan', async () => {
  await withSdk(
    (turn, paths) =>
      turn === 1
        ? read(paths.skill)
        : turn === 2
          ? read(paths.review)
          : [{ name: 'remembrancer_submit', args: { records: [], dispositions: [] } }],
    async (run, { requests }) => {
      await expect(run).resolves.toEqual([]);
      expect(requests).toHaveLength(3);
      expect(vi.mocked(readTaskCatalog)).not.toHaveBeenCalled();
    },
  );
});

it('rejects changed generated bytes before accepting evidence delivery', async () => {
  await withSdk(
    (turn, paths) => {
      if (turn === 1) return read(paths.skill);
      writeFileSync(paths.review, 'changed');
      return read(paths.review);
    },
    async (run, { current }) => {
      await expect(run).rejects.toThrow('changed');
      expect(() => current.completion([])).toThrow('Read all evidence');
    },
  );
});

it('does not acknowledge an oversized complete evidence result', async () => {
  await withSdk(
    (turn, paths) => read(turn === 1 ? paths.skill : paths.review),
    async (run, { current }) => {
      await expect(run).rejects.toThrow(/budget/);
      expect(() => current.completion([])).toThrow('Read all evidence');
    },
    { text: 'x'.repeat(45_000), contextWindow: 35_000 },
  );
});

it('rejects cleanup failure after valid submission without returning staged content', async () => {
  await withSdk(
    (turn, paths) => {
      if (turn === 1) return read(paths.skill);
      if (turn === 2) return read(paths.review);
      vi.mocked(unlinkSync).mockImplementation(() => {
        throw new Error('fixture cleanup failure');
      });
      return [{ name: 'remembrancer_submit', args: { records: [], dispositions: [] } }];
    },
    async (run, { db }) => {
      await expect(run).rejects.toThrow('cleanup failed');
      expect(db.proposals()).toEqual([]);
    },
  );
});

it('allows a prior-page reread without skipping the next required evidence page', async () => {
  await withSdk(
    (turn, paths) => {
      if (turn === 1) return read(paths.skill);
      if (turn < 4) return read(paths.review, 0);
      if (turn === 4) return read(paths.review, 1);
      return [{ name: 'remembrancer_submit', args: { records: [], dispositions: [] } }];
    },
    async (run, { requests, current }) => {
      await expect(run).resolves.toEqual([]);
      expect(requests).toHaveLength(5);
      expect(() => current.completion([])).not.toThrow();
    },
    { text: 'x'.repeat(55_000) },
  );
});

it('aborts a retained matching view on changed generation without exporting again', async () => {
  let changeGeneration = () => {};
  await withSdk(
    (turn, paths) => {
      if (turn === 1) return read(paths.skill);
      if (turn === 2) return read(paths.review);
      if (turn === 3) return [{ name: 'remembrancer_tasks', args: {} }];
      changeGeneration();
      return [{ name: 'remembrancer_proposals', args: {} }];
    },
    async (run, { db }) => {
      const generation = db.contextGeneration();
      const readGeneration = vi.spyOn(db, 'contextGeneration');
      changeGeneration = () => {
        readGeneration.mockReturnValue(generation + 1);
      };
      await expect(run).rejects.toThrow('context changed');
      expect(vi.mocked(readTaskCatalog)).toHaveBeenCalledOnce();
      expect(db.proposals()).toEqual([]);
    },
  );
});

it('aborts a missing proposal detail even when the generation guard alone would pass', async () => {
  await withSdk(
    (turn, paths) => {
      if (turn === 1) return read(paths.skill);
      if (turn === 2) return read(paths.review);
      if (turn === 3) return [{ name: 'remembrancer_proposals', args: {} }];
      return [
        { name: 'remembrancer_proposals', args: { action: 'detail', id: 'saved', revision: 2 } },
      ];
    },
    async (run, { db }) => {
      vi.spyOn(db, 'proposals').mockImplementation((_state, offset = 0) =>
        offset ? [] : [proposal()],
      );
      await expect(run).rejects.toThrow('Missing proposal');
      expect(vi.mocked(readTaskCatalog)).toHaveBeenCalledOnce();
    },
  );
});

it('keeps cancellation active through reviewer disposal, then removes generated artifacts', async () => {
  const controller = new AbortController();
  await withSdk(
    (turn, paths) => {
      if (turn === 1) return read(paths.skill);
      if (turn === 2) return read(paths.review);
      return [{ name: 'remembrancer_submit', args: { records: [], dispositions: [] } }];
    },
    async (run, { paths, db }) => {
      const dispose = AgentSession.prototype.dispose;
      const spy = vi.spyOn(AgentSession.prototype, 'dispose').mockImplementation(function (
        this: AgentSession,
      ) {
        expect(existsSync(paths.review)).toBe(true);
        dispose.call(this);
        controller.abort(new Error('late cancellation'));
      });
      try {
        await expect(run).rejects.toThrow('late cancellation');
        expect(spy).toHaveBeenCalledOnce();
        expect(existsSync(dirname(paths.review))).toBe(false);
        expect(db.proposals()).toEqual([]);
      } finally {
        spy.mockRestore();
      }
    },
    { signal: controller.signal },
  );
});

it('does not promote earlier supporting conversation to eligible evidence', () => {
  const { dir, payload } = fixture();
  const file = join(dir, 'historical.jsonl');
  writeFileSync(
    file,
    [
      { type: 'session', id: 'session', cwd: dir },
      {
        type: 'message',
        id: 'older',
        parentId: null,
        timestamp: '2026-01-01',
        message: { role: 'user', content: 'I will send Maya the comparison.' },
      },
      {
        type: 'message',
        id: 'entry',
        parentId: 'older',
        timestamp: '2026-01-30',
        message: { role: 'user', content: 'Still working on it.' },
      },
    ]
      .map((entry) => JSON.stringify(entry))
      .join('\n') + '\n',
  );
  const review = prepareReview([{ sessionId: 'session', file }], [], {
    requestedSince: '2026-01-29',
  });
  expect(review.evidence.map((item) => item.entryId)).toEqual(['entry']);
  const current = new CaptureReview(review, () => {});
  delivered(current);
  expect(
    JSON.stringify(
      current.context({
        batch: current.id,
        selected: { sessionId: 'session', branchId: 'entry', entryId: 'entry', editId: null },
        before: 1,
      }),
    ),
  ).toContain('I will send Maya');
  payload.records[0]!.observations[0]!.reference.entryId = 'older';
  expect(() => validateCaptureSubmission(payload, current, [], [])).toThrow('eligible evidence');
});

it('rejects citation boundaries that split a Unicode character', () => {
  const { current, payload } = fixture('😀');
  delivered(current);
  payload.records[0]!.observations[0]!.reference.quote = '\ud83d';
  expect(() => validateCaptureSubmission(payload, current, [], [])).toThrow('eligible evidence');
});

it('requires delivery of even the empty generated evidence page', () => {
  const { review } = fixture();
  review.evidence = [];
  const current = new CaptureReview(review, () => {});
  const artifacts = new CaptureArtifacts(current);
  try {
    artifacts.read(artifacts.skillPath).accept();
    expect(() => artifacts.assertDelivered()).toThrow('Read all evidence');
    artifacts.read(artifacts.reviewPath).accept();
    expect(() => artifacts.assertDelivered()).not.toThrow();
  } finally {
    artifacts.dispose();
  }
});

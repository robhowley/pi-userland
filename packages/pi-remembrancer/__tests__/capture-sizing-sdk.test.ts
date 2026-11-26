import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { expect, it, vi } from 'vitest';
import { CaptureReview } from '../extensions/remembrancer/capture-review.js';
import { reviewPreparedCapture, CAPTURE_BUDGET_MS } from '../extensions/remembrancer/capture.js';
import { CheckpointStore } from '../extensions/remembrancer/checkpoints.js';
import { prepareReview } from '../extensions/remembrancer/evidence.js';
import {
  estimateReviewerTokens,
  getReviewerBudget,
  ReviewerBudgetError,
} from '../extensions/remembrancer/reviewer-budget.js';
import {
  readTaskCatalog,
  snapshot,
  type TaskRecord,
} from '../extensions/remembrancer/taskwarrior.js';
import type { CaptureSubmission } from '../extensions/remembrancer/capture-submission.js';
import type { EvidencePageEntry } from '../extensions/remembrancer/review-pages.js';
import {
  captureRecord,
  captureReference,
  captureDisposition,
  captureToolCalls,
  reviewerPaths,
  type CaptureToolCall,
} from './fixtures/capture-reviewer.js';
import { writeCompletion } from './fixtures/openai-loopback.js';

vi.mock('../extensions/remembrancer/taskwarrior.js', async (original) => ({
  ...(await original<typeof import('../extensions/remembrancer/taskwarrior.js')>()),
  readTaskCatalog: vi.fn(),
}));

// Complete real SDK requests, retained history, and one terminal output budget.
async function measure(
  texts: string[],
  output: number,
  options: {
    contextWindow?: number;
    tasks?: TaskRecord[];
    dense?: boolean;
    context?: string;
    oversized?: boolean;
  } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), 'capture-sizing-'));
  const agentDir = join(dir, 'agent');
  mkdirSync(agentDir);
  vi.mocked(readTaskCatalog)
    .mockReset()
    .mockResolvedValue(options.tasks ?? []);
  const requests: Record<string, unknown>[] = [];
  const outputs: number[] = [];
  const evidence: EvidencePageEntry[] = [];
  const contextText: string[] = [];
  let nextPage = 0;
  let evidenceDone = false;
  let taskRead = '';
  let taskNext: object | null = options.tasks?.length ? { uuid: options.tasks[0]!['uuid'] } : null;
  let contextOffset: number | null = options.context ? 0 : null;
  let lastCall: CaptureToolCall | undefined;
  let fixtureError: unknown;
  let submitCalls = 0;
  function payload(): CaptureSubmission {
    const records: CaptureSubmission['records'] = [];
    const dispositions: CaptureSubmission['dispositions'] = [];
    for (const entry of evidence) {
      const matches = options.dense ? [...entry.text.matchAll(/accepted:t(\d+)\|Do \d+;/g)] : [];
      const found = options.dense
        ? matches.map((match) => ({
            start: match.index!,
            end: match.index! + match[0].length,
            description: `Do ${match[1]};`,
          }))
        : entry.text.startsWith('accepted:')
          ? [{ start: 0, end: entry.text.length, description: entry.text.split('|')[1]! }]
          : [];
      for (const item of found) {
        const key = `record${records.length}`;
        const task = options.tasks?.[0];
        const change = task
          ? {
              operation: 'update' as const,
              targetUuid: String(task['uuid']),
              fields: { priority: 'H' as const },
              annotations: [],
            }
          : {
              operation: 'add' as const,
              fields: { description: item.description },
              annotations: [],
            };
        records.push(
          captureRecord(
            key,
            [{ kind: 'accepted', reference: captureReference(entry, item.start, item.end) }],
            [
              {
                branchId: entry.branchId,
                state: {
                  summary: item.description,
                  status: 'active',
                  draft: { change, question: null },
                },
              },
            ],
            {
              candidates: task
                ? [{ kind: 'task', id: String(task['uuid']), judgment: 'same' }]
                : [],
            },
          ),
        );
        dispositions.push(
          captureDisposition(
            [key],
            { change, question: null, explanation: 'Exact reviewer intent' },
            'Accepted',
          ),
        );
      }
    }
    return { records, dispositions };
  }
  const contentText = (content: unknown) =>
    typeof content === 'string'
      ? content
      : (content as { text?: string }[]).map((part) => part.text ?? '').join('');
  const server = createServer(async (request, response) => {
    try {
      request.setEncoding('utf8');
      let raw = '';
      for await (const chunk of request) raw += chunk;
      const body = JSON.parse(raw);
      requests.push(body);
      const messages = body.messages as { role: string; content: unknown }[];
      const paths = reviewerPaths(
        contentText(messages.find((message) => message.role === 'user')!.content),
      );
      const last = messages.filter((message) => message.role === 'tool').at(-1);
      if (
        last &&
        lastCall &&
        !(
          lastCall.name === 'remembrancer_read' &&
          (lastCall.args as { path: string }).path === paths.skill
        )
      ) {
        const data = JSON.parse(contentText(last.content));
        expect(Buffer.byteLength(contentText(last.content))).toBeLessThanOrEqual(51_200);
        if (lastCall.name === 'remembrancer_read') {
          for (const { entries, ...group } of data.groups)
            for (const entry of entries) evidence.push({ ...group, ...entry });
          evidenceDone = !data.hasMore;
        } else if (lastCall.name === 'remembrancer_tasks') {
          taskRead += data.json;
          taskNext = data.next;
        } else if (lastCall.name === 'remembrancer_context') {
          expect(data.contextOnly).toBe(true);
          for (const group of data.groups)
            for (const entry of group.entries) contextText.push(entry.text);
          contextOffset = data.nextOffset;
        }
      }
      let call: CaptureToolCall;
      if (requests.length === 1) call = { name: 'remembrancer_read', args: { path: paths.skill } };
      else if (!evidenceDone)
        call = { name: 'remembrancer_read', args: { path: paths.review, page: nextPage++ } };
      else if (taskNext) call = { name: 'remembrancer_tasks', args: taskNext };
      else if (contextOffset !== null) {
        const entry = evidence[0]!;
        call = {
          name: 'remembrancer_context',
          args: {
            selected: {
              sessionId: entry.sessionId,
              branchId: entry.branchId,
              entryId: entry.entryId,
              editId: entry.editId,
            },
            before: 1,
            offset: contextOffset,
          },
        };
      } else {
        call = {
          name: 'remembrancer_submit',
          args: options.oversized
            ? { records: [], dispositions: [], extra: 'x'.repeat(2000) }
            : payload(),
        };
        submitCalls++;
      }
      lastCall = call;
      outputs.push(estimateReviewerTokens(captureToolCalls([call], requests.length)));
      writeCompletion(response, captureToolCalls([call], requests.length), 'tool_calls');
    } catch (error) {
      fixtureError = error;
      response.writeHead(500);
      response.end('Fixture failure');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const db = new CheckpointStore(join(dir, 'index.sqlite'));
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing local transport');
    writeFileSync(
      join(agentDir, 'models.json'),
      JSON.stringify({
        providers: {
          fixture: {
            api: 'openai-completions',
            baseUrl: `http://127.0.0.1:${address.port}/v1`,
            apiKey: 'local-fixture',
            models: [
              {
                id: 'fixture',
                name: 'Fixture',
                reasoning: false,
                input: ['text'],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: options.contextWindow ?? 400_000,
                maxTokens: output,
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
    const model = runtime.getModel('fixture', 'fixture')!;
    const file = join(dir, 'session.jsonl');
    const rows: object[] = [{ type: 'session', id: 'sizing', cwd: dir }];
    if (options.context)
      rows.push({
        type: 'message',
        id: 'older',
        parentId: null,
        timestamp: '2026-01-01',
        message: { role: 'user', content: options.context },
      });
    texts.forEach((content, i) =>
      rows.push({
        type: 'message',
        id: `entry-${i}`,
        parentId: i ? `entry-${i - 1}` : options.context ? 'older' : null,
        timestamp: '2026-01-30',
        message: { role: 'user', content },
      }),
    );
    writeFileSync(file, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
    const current = new CaptureReview(
      prepareReview(
        [{ file, sessionId: 'sizing' }],
        [],
        options.context ? { requestedSince: '2026-01-29' } : undefined,
      ),
      () => {},
    );
    const start = Date.now();
    let error: unknown;
    const submissions = await reviewPreparedCapture(
      current,
      db,
      { cwd: dir, agentDir, sessionId: 'sizing', model, modelRuntime: runtime },
      () => {
        if (Date.now() - start >= CAPTURE_BUDGET_MS) throw new Error('Attempt deadline');
      },
    ).catch((failure: unknown) => {
      error = failure;
      return undefined;
    });
    if (fixtureError) throw fixtureError;
    expect(
      requests.every(
        (request) => estimateReviewerTokens(request) <= getReviewerBudget(model).maxInputTokens,
      ),
    ).toBe(true);
    for (const [index, request] of requests.entries()) {
      const messages = request['messages'] as { role: string }[];
      expect(messages.filter((message) => message.role === 'user')).toHaveLength(1);
      expect(messages.filter((message) => message.role === 'tool')).toHaveLength(index);
    }
    expect(db.proposals()).toEqual([]);
    expect(db.reviewed()).toEqual([]); // The helper only stages.
    return {
      submissions,
      error,
      current,
      requests,
      evidence,
      outputs,
      taskRead,
      contextText,
      submitCalls,
    };
  } finally {
    db.close();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    rmSync(dir, { recursive: true, force: true });
  }
}

it.each([512, 4096])(
  'delivers all 40 KiB ASCII with retained history at output %i',
  async (output) => {
    const source = '.'.repeat(40 * 1024);
    const result = await measure([source], output);
    expect(result.error).toBeUndefined();
    expect(result.submissions).toEqual([]);
    expect(result.evidence.map((entry) => entry.text).join('')).toBe(source);
    expect(result.submitCalls).toBe(1);
    expect(result.requests.length).toBeGreaterThanOrEqual(3);
  },
);

it.each([512, 4096, 32_768])(
  'bounds 24 independent obligations in one terminal reply at output %i',
  async (output) => {
    const texts = Array.from({ length: 24 }, (_, i) => `accepted:t${i}|Do ${i};`);
    const result = await measure(texts, output);
    expect(result.submitCalls).toBe(1);
    if (output < 32_768) {
      expect(result.error).toBeInstanceOf(ReviewerBudgetError);
      expect(result.submissions).toBeUndefined();
    } else {
      expect(result.error).toBeUndefined();
      expect(result.submissions).toHaveLength(24);
      expect(result.submissions!.map((item) => item.references)).toEqual(
        texts.map((quote, i) => [
          {
            sessionId: 'sizing',
            branchId: 'entry-23',
            entryId: `entry-${i}`,
            editId: null,
            offset: 0,
            quote,
          },
        ]),
      );
    }
  },
);

it.each([512, 4096, 32_768])(
  'never splits dense terminal output into host-directed extraction turns at %i',
  async (output) => {
    const source = Array.from({ length: 24 }, (_, i) => `accepted:t${i}|Do ${i};`).join('');
    const result = await measure([source], output, { dense: true });
    expect(result.evidence.map((entry) => entry.text).join('')).toBe(source);
    expect(result.submitCalls).toBe(1);
    expect(result.requests).toHaveLength(3);
    if (output < 32_768) expect(result.error).toBeInstanceOf(ReviewerBudgetError);
    else {
      expect(result.error).toBeUndefined();
      expect(result.submissions).toHaveLength(24);
      expect(result.submissions!.map((item) => item.references[0]!.quote).join('')).toBe(source);
    }
  },
);

it('reads a compact exact task without serializing its leaves into the opening prompt', async () => {
  const task = {
    uuid: '12345678-1234-1234-1234-123456789abc',
    status: 'pending',
    description: 'Do it',
    ...Object.fromEntries(Array.from({ length: 130 }, (_, i) => [`custom${i}`, `value${i}`])),
  };
  const result = await measure(['accepted:t|Do it'], 4096, { tasks: [task] });
  expect(result.error).toBeUndefined();
  expect(JSON.parse(result.taskRead)).toEqual(task);
  expect(result.requests).toHaveLength(4);
  expect(JSON.stringify(result.requests[0])).not.toContain('custom129');
  expect(result.submissions![0]!.expected).toEqual(snapshot(task));
});

it.each([512, 4096])(
  'reads a long singleton by bounded exact JSON fragments at output %i',
  async (output) => {
    const task = {
      uuid: '12345678-1234-1234-1234-123456789abc',
      status: 'pending',
      description: 'Do it',
      notes: '😀\\"\n'.repeat(8000),
      ...Object.fromEntries(
        Array.from({ length: 130 }, (_, i) => [`custom${i}`, String(i).padStart(100, 'x')]),
      ),
    };
    const result = await measure(['accepted:t|Do it'], output, { tasks: [task] });
    expect(JSON.parse(result.taskRead)).toEqual(task);
    expect(result.requests.length).toBeGreaterThan(4);
    expect(readTaskCatalog).toHaveBeenCalledOnce();
    if (output === 512) expect(result.error).toBeInstanceOf(ReviewerBudgetError);
    else {
      expect(result.error).toBeUndefined();
      expect(result.submissions![0]!.expected).toEqual(snapshot(task));
    }
  },
);

it('retains escaped earlier context in the SDK history without making it eligible evidence', async () => {
  const source = 'memo\n"😀'.repeat(8000);
  const result = await measure(['Nothing actionable.'], 4096, { context: source });
  expect(result.error).toBeUndefined();
  expect(result.submissions).toEqual([]);
  expect(result.contextText.join('')).toBe(source);
  expect(JSON.stringify(result.requests.at(-1))).toContain('memo');
  expect(() =>
    result.current.validateReferences([
      {
        sessionId: 'sizing',
        branchId: 'entry-0',
        entryId: 'older',
        editId: null,
        offset: 0,
        quote: source.slice(0, 10),
      },
    ]),
  ).toThrow('eligible evidence');
});

it('fails when retained evidence exceeds context, without compaction, restart or partial result', async () => {
  const result = await measure(['😀'.repeat(40_000)], 4096, { contextWindow: 90_000 });
  expect(result.error).toBeInstanceOf(ReviewerBudgetError);
  expect(result.submissions).toBeUndefined();
  expect(result.submitCalls).toBe(0);
  expect(result.requests.length).toBeGreaterThan(1);
  expect(() => result.current.completion([])).toThrow('Read all evidence');
});

it('rejects oversized tool-call arguments even if the local provider ignores its output ceiling', async () => {
  const result = await measure(['nothing'], 512, { oversized: true });
  expect(result.error).toBeInstanceOf(ReviewerBudgetError);
  expect(result.submitCalls).toBe(1);
  expect(result.submissions).toBeUndefined();
  expect(result.requests).toHaveLength(3);
});

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { expect, it, vi } from 'vitest';
import { CaptureReview } from '../extensions/remembrancer/capture-review.js';
import { reviewPreparedCapture, CAPTURE_BUDGET_MS } from '../extensions/remembrancer/capture.js';
import { captureReplySize, type CaptureField } from '../extensions/remembrancer/capture-sizing.js';
import type { CheckpointStore } from '../extensions/remembrancer/checkpoints.js';
import { prepareReview } from '../extensions/remembrancer/evidence.js';
import { getReviewerBudget } from '../extensions/remembrancer/reviewer-budget.js';
import {
  readTaskCatalog,
  snapshot,
  type TaskRecord,
} from '../extensions/remembrancer/taskwarrior.js';
import { captureAnswer, providerInstruction } from './fixtures/capture-steps.js';
import { writeCompletion } from './fixtures/openai-loopback.js';

vi.mock('../extensions/remembrancer/taskwarrior.js', async (original) => ({
  ...(await original<typeof import('../extensions/remembrancer/taskwarrior.js')>()),
  readTaskCatalog: vi.fn(),
}));

type Envelope = { work: any; memory: string; detail: any };
async function measure(
  texts: string[],
  output: 512 | 4096,
  answer?: (envelope: Envelope, instruction: string) => unknown,
  tasks: TaskRecord[] = [],
) {
  const dir = mkdtempSync(join(tmpdir(), 'capture-sizing-'));
  const agentDir = join(dir, 'agent');
  mkdirSync(agentDir);
  vi.mocked(readTaskCatalog).mockResolvedValue(tasks);
  const requests: { bytes: number; envelope: Envelope; instruction: string }[] = [];
  const outputs: number[] = [];
  const server = createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const payload = JSON.parse(raw);
    const instruction = providerInstruction(payload.messages);
    const envelope = JSON.parse(instruction.split('\n').at(-1)!) as Envelope;
    requests.push({ bytes: Buffer.byteLength(raw), envelope, instruction });
    const result = answer?.(envelope, instruction) ?? { answer: captureAnswer(instruction) };
    const args = { result };
    outputs.push(Buffer.byteLength(JSON.stringify({ name: 'remembrancer_step', arguments: args })));
    writeCompletion(
      response,
      {
        role: 'assistant',
        tool_calls: [
          {
            index: 0,
            id: `call-${requests.length}`,
            type: 'function',
            function: { name: 'remembrancer_step', arguments: JSON.stringify(args) },
          },
        ],
      },
      'tool_calls',
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing local transport');
    // Both configurations have exactly 16,804 conservative input tokens available.
    const contextWindow = output === 4096 ? 22000 : 18340;
    writeFileSync(
      join(agentDir, 'models.json'),
      JSON.stringify({
        providers: {
          fixture: {
            baseUrl: `http://127.0.0.1:${address.port}/v1`,
            apiKey: 'local-fixture',
            api: 'openai-completions',
            models: [
              {
                id: 'fixture',
                name: 'fixture',
                reasoning: false,
                input: ['text'],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow,
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
    writeFileSync(
      file,
      [
        { type: 'session', id: 'sizing', cwd: dir },
        ...texts.map((content, index) => ({
          type: 'message',
          id: `entry-${index}`,
          parentId: index ? `entry-${index - 1}` : null,
          message: { role: 'user', content },
        })),
      ]
        .map((row) => JSON.stringify(row))
        .join('\n') + '\n',
    );
    const current = new CaptureReview(prepareReview([{ file, sessionId: 'sizing' }], []), () => {});
    const db = { contextGeneration: () => 0, proposals: () => [] } as unknown as CheckpointStore;
    const start = Date.now();
    const submissions = await reviewPreparedCapture(
      current,
      db,
      {
        cwd: dir,
        agentDir,
        sessionId: 'sizing',
        model,
        modelRuntime: runtime,
      },
      () => {
        if (Date.now() - start >= CAPTURE_BUDGET_MS) throw new Error('Attempt deadline');
      },
    );
    expect(() => current.completion(submissions)).not.toThrow();
    const budget = getReviewerBudget(model);
    expect(budget.maxInputTokens).toBe(16804);
    expect(requests.every(({ bytes }) => bytes <= budget.maxInputTokens)).toBe(true);
    expect(outputs.every((bytes) => bytes <= output)).toBe(true);
    return { submissions, requests, outputs, elapsedMs: Date.now() - start };
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    rmSync(dir, { recursive: true, force: true });
  }
}

it.each([512, 4096] as const)(
  'fits 40 KiB ASCII by complete SDK input at output %i',
  async (output) => {
    const source = '.'.repeat(40 * 1024);
    const result = await measure([source], output);
    const ranges = result.requests.map(({ envelope }) => envelope.work.range);
    expect(ranges.map((range) => range.text).join('')).toBe(source);
    expect(result.submissions).toEqual([]);
    expect(result.requests.length).toBeLessThanOrEqual(8);
    console.log(
      JSON.stringify({
        sizing: '40-KiB',
        outputCeilingTokens: output,
        extractionCalls: ranges.length,
        totalModelCalls: result.requests.length,
        largestProviderPayloadBytes: Math.max(...result.requests.map((request) => request.bytes)),
        elapsedMs: result.elapsedMs,
      }),
    );
  },
);

it.each([512, 4096] as const)(
  'reduces 24 independent one-branch obligations at output %i',
  async (output) => {
    const texts = Array.from({ length: 24 }, (_, index) => `accepted:t${index}|Do ${index};`);
    const result = await measure(texts, output);
    expect(result.submissions).toHaveLength(24);
    expect(result.submissions.map((item) => item.references)).toEqual(
      texts.map((quote, index) => [
        {
          sessionId: 'sizing',
          branchId: 'entry-23',
          entryId: `entry-${index}`,
          editId: null,
          offset: 0,
          quote,
        },
      ]),
    );
    expect(result.requests.length).toBeLessThan(95);
    expect(
      result.requests.filter(({ instruction }) => instruction.includes('Materialize')),
    ).toHaveLength(0);
    console.log(
      JSON.stringify({
        sizing: '24-independent',
        outputCeilingTokens: output,
        extractionCalls: result.requests.filter(({ envelope }) => envelope.work.range).length,
        totalModelCalls: result.requests.length,
        largestProviderPayloadBytes: Math.max(...result.requests.map((request) => request.bytes)),
        elapsedMs: result.elapsedMs,
      }),
    );
  },
);

it('changes dense reply paging with output ceiling alone, including late continuation memory', async () => {
  const source = Array.from({ length: 24 }, (_, index) => `accepted:t${index}|Do ${index};`).join(
    '',
  );
  const counts: number[] = [];
  for (const output of [512, 4096] as const) {
    const result = await measure([source], output, ({ work }, instruction) => {
      if (!work.range) return { answer: captureAnswer(instruction) };
      const all = [...work.range.text.matchAll(/accepted:t(\d+)\|Do \d+;/g)].map((match) => ({
        kind: 'accepted',
        label: `t${match[1]}`,
        start: match.index!,
        end: match.index! + match[0].length,
      }));
      const observations = all.slice(
        work.observationOffset,
        work.observationOffset + work.maxObservations,
      );
      const next = work.observationOffset + observations.length;
      return {
        answer: {
          complete: next === all.length,
          observations,
          nextObservationOffset: next === all.length ? null : next,
          memory: `next:${next}`,
        },
      };
    });
    const extractions = result.requests.filter(({ envelope }) => envelope.work.range);
    expect(new Set(extractions.map(({ envelope }) => envelope.work.range.id)).size).toBe(1);
    expect(extractions.at(-1)!.envelope.work.extractionMemory).toMatch(/^next:/);
    expect(result.submissions).toHaveLength(24);
    expect(result.submissions.map((item) => item.references[0]!.quote).join('')).toBe(source);
    counts.push(extractions.length);
    console.log(
      JSON.stringify({
        sizing: 'dense-24',
        outputCeilingTokens: output,
        extractionCalls: extractions.length,
        totalModelCalls: result.requests.length,
      }),
    );
  }
  expect(counts[0]).toBeGreaterThan(counts[1]!);
});

it('packs compact exact candidates inline rather than rereading every leaf', async () => {
  const task = {
    uuid: '12345678-1234-1234-1234-123456789abc',
    status: 'pending',
    description: 'Do it',
    ...Object.fromEntries(Array.from({ length: 130 }, (_, i) => [`custom${i}`, `value${i}`])),
  };
  const result = await measure(
    ['accepted:t|Do it'],
    4096,
    ({ work }, instruction) => {
      if (work.catalogue?.[0]?.handle)
        return { answer: { candidates: [work.catalogue[0].handle] } };
      if (instruction.includes('All exact candidate fields')) {
        expect(work.candidate).toEqual(task);
        return { answer: { match: 'same' } };
      }
      if (instruction.includes('Materialize'))
        return {
          answer: {
            reason: 'Update exact match',
            submission: {
              change: {
                operation: 'update',
                targetUuid: task.uuid,
                fields: { priority: 'H' },
                annotations: [],
              },
              question: null,
              explanation: 'Exact existing task',
            },
          },
        };
      return { answer: captureAnswer(instruction) };
    },
    [task],
  );
  expect(result.requests.some(({ envelope }) => envelope.work.page)).toBe(false);
  expect(result.submissions[0]!.expected).toEqual(snapshot(task));
});

it.each([512, 4096] as const)(
  'pages a long singleton in exact field batches at output %i',
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
    const seen = new Map<string, unknown>();
    const result = await measure(
      ['accepted:t|Do it'],
      output,
      ({ work }, instruction) => {
        if (work.catalogue?.[0]?.handle) {
          expect(work.catalogue[0].identity).toEqual({ valueHandle: expect.any(String) });
          expect(work.catalogue[0].uncertainIdentity).toBe(true);
          return { answer: { candidates: [] } };
        }
        if (work.page) {
          for (const field of work.page.fields as CaptureField[]) {
            const key = field.path.join('.');
            seen.set(
              key,
              'value' in field ? field.value : String(seen.get(key) ?? '') + field.text,
            );
          }
          return { answer: { notes: 'Exact matching task' } };
        }
        if (instruction.includes('All exact candidate fields'))
          return { answer: { match: 'same' } };
        if (instruction.includes('Materialize'))
          return {
            answer: {
              reason: 'Update exact match',
              submission: {
                change: {
                  operation: 'update',
                  targetUuid: task.uuid,
                  fields: { priority: 'H' },
                  annotations: [],
                },
                question: null,
                explanation: 'Exact existing task',
              },
            },
          };
        return { answer: captureAnswer(instruction) };
      },
      [task],
    );
    expect(Object.fromEntries(seen)).toEqual(task);
    const pages = result.requests.filter(({ envelope }) => envelope.work.page);
    expect(pages.some(({ envelope }) => envelope.work.page.fields.length > 1)).toBe(true);
    expect(pages.length).toBeLessThan(30);
    expect(result.submissions[0]!.expected).toEqual(snapshot(task));
    console.log(
      JSON.stringify({
        sizing: 'long-singleton',
        outputCeilingTokens: output,
        extractionCalls: result.requests.filter(({ envelope }) => envelope.work.range).length,
        totalModelCalls: result.requests.length,
        fieldBatchCalls: pages.length,
      }),
    );
  },
);

it('fits late exact context plus escaped continuation memory in the complete SDK payload', async () => {
  const source = 'x'.repeat(40 * 1024);
  let inspected = false;
  let originalRange: any;
  const result = await measure([source], 4096, ({ work, detail }, instruction) => {
    if (!inspected && work.range.offset > 0) {
      inspected = true;
      originalRange = work.range;
      return {
        inspect: { kind: 'context', rangeId: work.range.id, messageOffset: 0 },
        memory: 'memo\n"'.repeat(250),
      };
    }
    if (detail) {
      expect(detail.groups[0].entries[0].text).toBe(source.slice(0, detail.nextOffset));
      expect(detail.nextOffset).toBeGreaterThan(0);
      expect(originalRange.offset).toBeGreaterThan(0);
      return { answer: { complete: true, observations: [] } };
    }
    return { answer: captureAnswer(instruction, true) };
  });
  expect(inspected).toBe(true);
  expect(result.requests.some(({ envelope }) => envelope.memory.includes('memo'))).toBe(true);
});

it('rejects an oversized tool result even when a local provider ignores its output ceiling', async () => {
  expect(captureReplySize({ complete: true, observations: [] })).toBeLessThan(512);
  await expect(
    measure(['nothing'], 512, () => ({
      answer: { complete: true, observations: [], extra: 'x'.repeat(1000) },
    })),
  ).rejects.toThrow('reply exceeds output allowance');
});

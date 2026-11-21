import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModelRuntime, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { expect, it, vi } from 'vitest';
import { preserveHandoff } from '../extensions/remembrancer/capture-handoff.js';
import { runCaptureWorker } from '../extensions/remembrancer/capture-worker.js';
import { captureExecution } from '../extensions/remembrancer/config.js';
import { getReviewerBudget } from '../extensions/remembrancer/reviewer-budget.js';
import { lookupTasks, snapshot } from '../extensions/remembrancer/taskwarrior.js';
import { captureAnswer, providerInstruction, stepWork } from './fixtures/capture-steps.js';
import { CheckpointStore } from '../extensions/remembrancer/checkpoints.js';

// Exercise ordinary SDK startup and its real tool loop against a deterministic local transport.
// No provider adapter, credentials, external requests or Taskwarrior commands.
vi.mock('../extensions/remembrancer/taskwarrior.js', async (original) => ({
  ...(await original<typeof import('../extensions/remembrancer/taskwarrior.js')>()),
  lookupTasks: vi.fn().mockResolvedValue({ tasks: [], nextOffset: null }),
}));
it.each([
  { outcome: 'empty', requests: 1, covered: true },
  { outcome: 'proposal', requests: 3, covered: true },
  { outcome: 'large', requests: 0, covered: true },
  { outcome: 'aliases', requests: 0, covered: true },
  { outcome: 'dense', requests: 0, covered: true },
  { outcome: 'dense-truncated', requests: 2, covered: false },
  { outcome: 'growing', requests: 0, covered: true },
  { outcome: 'renamed', requests: 0, covered: true },
  { outcome: 'aggregate-object', requests: 0, covered: true },
  { outcome: 'aggregate-array', requests: 0, covered: true },
  { outcome: 'mixed', requests: 1, covered: false },
  { outcome: 'duplicate', requests: 1, covered: false },
  { outcome: 'unread', requests: 1, covered: false },
  { outcome: 'missing', requests: 1, covered: false },
  { outcome: 'overflow', requests: 1, covered: false },
  { outcome: 'tool-error', requests: 1, covered: false },
  { outcome: 'provider-error', requests: 1, covered: false },
])(
  'installed SDK capture outcome=$outcome',
  async ({ outcome, requests: expectedRequests, covered }) => {
    const denseCase = outcome.startsWith('dense');
    const aggregateCase = outcome.startsWith('aggregate-');
    const boundedCase =
      aggregateCase || denseCase || ['large', 'aliases', 'growing', 'renamed'].includes(outcome);
    const task = {
      uuid: '12345678-1234-1234-1234-123456789abc',
      status: 'pending',
      description: aggregateCase
        ? 'Send Maya the comparison.'
        : 'Unrelated leading label '.repeat(40) + 'comparison',
      annotations:
        outcome === 'aggregate-array'
          ? Array.from({ length: 45 }, (_, index) => ({
              entry: '20260101T000000Z',
              description: `Short annotation ${index}`,
            }))
          : aggregateCase
            ? []
            : [{ entry: '20260101T000000Z', description: 'Retain exact snapshot '.repeat(300) }],
      ...(outcome === 'aggregate-object'
        ? Object.fromEntries(
            Array.from({ length: 130 }, (_, index) => [`custom${index}`, `short value ${index}`]),
          )
        : {}),
    };
    vi.mocked(lookupTasks).mockResolvedValue({
      tasks: outcome === 'renamed' || aggregateCase ? [task] : [],
      nextOffset: null,
    });
    const taskFields = new Map<string, unknown>();
    let aliasInspected = false;
    let valuePages = 0;
    const valueText: string[] = [];
    let continuations = 0;
    let largestOutput = 0;
    const dir = mkdtempSync(join(tmpdir(), 'capture-sdk-'));
    const agent = join(dir, 'agent');
    mkdirSync(agent);
    const sentinel = 'RESOURCE_MUST_NOT_LOAD';
    for (const root of [agent, dir]) {
      writeFileSync(join(root, 'AGENTS.md'), sentinel);
    }
    for (const root of [agent, join(dir, '.pi')]) {
      mkdirSync(join(root, 'extensions'), { recursive: true });
      mkdirSync(join(root, 'skills', 'sentinel'), { recursive: true });
      mkdirSync(join(root, 'prompts'), { recursive: true });
      writeFileSync(
        join(root, 'extensions', 'forbidden.ts'),
        'throw new Error("RESOURCE_MUST_NOT_LOAD");',
      );
      writeFileSync(
        join(root, 'skills', 'sentinel', 'SKILL.md'),
        '---\nname: sentinel\ndescription: RESOURCE_MUST_NOT_LOAD\n---\n' + sentinel,
      );
      writeFileSync(join(root, 'prompts', 'sentinel.md'), sentinel);
      writeFileSync(join(root, 'SYSTEM.md'), sentinel);
      writeFileSync(join(root, 'APPEND_SYSTEM.md'), sentinel);
    }
    const requests: Record<string, unknown>[] = [];
    const server = createServer(async (request, response) => {
      let body = '';
      for await (const chunk of request) body += chunk;
      requests.push(JSON.parse(body));
      if (outcome === 'provider-error') {
        response.writeHead(429, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({ error: { message: 'Fixture unavailable', type: 'rate_limit_error' } }),
        );
        return;
      }
      const names =
        outcome === 'missing' || outcome === 'overflow'
          ? []
          : outcome === 'unread'
            ? ['remembrancer_submit']
            : outcome === 'tool-error'
              ? ['remembrancer_tasks']
              : outcome === 'mixed'
                ? ['remembrancer_step', 'remembrancer_submit']
                : outcome === 'duplicate'
                  ? ['remembrancer_step', 'remembrancer_step']
                  : ['remembrancer_step'];
      const messages = requests.at(-1)!['messages'] as { role: string; content: string }[];
      const instruction = providerInstruction(messages);
      const envelope = JSON.parse(instruction.slice(instruction.lastIndexOf('\n') + 1));
      const work = envelope.work;
      let result: object = { answer: captureAnswerForCase() };
      function captureAnswerForCase(): unknown {
        if (denseCase && work.range) {
          const all = [...work.range.text.matchAll(/accepted:t(\d)\|Do\d;/g)].map((match) => ({
            kind: 'accepted',
            label: `t${match[1]}`,
            start: work.range.offset + match.index!,
            end: work.range.offset + match.index! + match[0].length,
          }));
          const observations = all.slice(
            work.observationOffset,
            work.observationOffset + work.maxObservations,
          );
          const next = work.observationOffset + observations.length;
          continuations += Number(next < all.length);
          return {
            complete: next === all.length,
            observations,
            nextObservationOffset: next < all.length ? next : null,
            memory: `Next observation ${next}`,
          };
        }
        if (outcome === 'growing' && work.observation && !work.candidate && !work.catalogue) {
          const part = work.observation.range.text.split('|')[1];
          const prior = work.previous?.draft.change.fields.description;
          return {
            summary: 'growing',
            status: 'active',
            draft: {
              change: {
                operation: 'add',
                fields: {
                  description:
                    prior === undefined
                      ? part
                      : typeof prior === 'string'
                        ? prior + part
                        : { ...prior, append: part },
                },
                annotations: [],
              },
              expected: null,
              question: null,
            },
          };
        }
        if ((outcome === 'renamed' || aggregateCase) && work.page) {
          const key = work.page.path.join('.');
          taskFields.set(
            key,
            work.page.text === undefined
              ? work.page.value
              : String(taskFields.get(key) ?? '') + work.page.text,
          );
          const identity =
            work.page.path.join('.') === 'description' && work.page.text?.includes('comparison');
          return {
            notes:
              identity || work.notes?.includes('same comparison')
                ? 'same comparison'
                : 'identity not yet found',
          };
        }
        if (
          (outcome === 'renamed' || aggregateCase) &&
          instruction.includes('All exact candidate fields')
        ) {
          const candidate = work.candidate;
          return {
            match: work.notes === 'same comparison' ? 'same' : 'different',
            state: {
              summary: 'comparison',
              status: 'active',
              draft: {
                change: {
                  operation: 'update',
                  targetUuid: candidate.uuid ?? taskFields.get('uuid'),
                  fields: { priority: 'H' },
                  annotations: [],
                },
                expected: {
                  uuid: candidate.uuid ?? taskFields.get('uuid'),
                  status: candidate.status ?? taskFields.get('status'),
                  fields: { description: candidate.description ?? taskFields.get('description') },
                  annotations: candidate.annotations ?? [],
                },
                question: null,
              },
            },
          };
        }
        return captureAnswer(instruction, outcome !== 'proposal' && !boundedCase);
      }
      if (
        outcome === 'aliases' &&
        work.range?.occurrenceCount === 40 &&
        !envelope.detail &&
        !aliasInspected
      ) {
        result = {
          inspect: { kind: 'occurrences', rangeId: work.range.id, index: 39 },
          memory: 'Check last branch applicability',
        };
      }
      if (outcome === 'aliases' && envelope.detail?.occurrence) {
        expect(envelope.detail.occurrence.branchId).toBe('leaf39');
        aliasInspected = true;
      }
      // Exercise paged inspection of a retained growing draft, then copy it on.
      const retained = work.previous?.draft?.change?.fields?.description;
      if (outcome === 'growing' && retained?.valueHandle && valuePages === 0 && !envelope.detail) {
        result = {
          inspect: { kind: 'value', valueHandle: retained.valueHandle, index: 0 },
          memory: 'Read the retained draft before appending',
        };
      }
      if (outcome === 'growing' && envelope.detail?.page) {
        valuePages++;
        valueText.push(envelope.detail.page.text);
        if (envelope.detail.nextIndex !== null)
          result = {
            inspect: {
              kind: 'value',
              valueHandle: retained.valueHandle,
              index: envelope.detail.nextIndex,
            },
            memory: 'Continue reading the exact retained draft',
          };
      }
      const args = { result };
      largestOutput = Math.max(largestOutput, Buffer.byteLength(JSON.stringify(args)));
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(
        `data: ${JSON.stringify({ id: 'offline', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: names.map((name, index) => ({ index, id: `call-${requests.length}-${index}`, type: 'function', function: { name, arguments: JSON.stringify(args) } })) }, finish_reason: null }] })}\n\n`,
      );
      response.write(
        `data: ${JSON.stringify({ id: 'offline', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta: {}, finish_reason: outcome === 'overflow' || (outcome === 'dense-truncated' && requests.length === 2) ? 'length' : names.length ? 'tool_calls' : 'stop' }] })}\n\n`,
      );
      response.end('data: [DONE]\n\n');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing fixture port');
    vi.stubEnv('PI_CODING_AGENT_DIR', agent);
    vi.stubEnv('XDG_STATE_HOME', dir);
    writeFileSync(
      join(agent, 'models.json'),
      JSON.stringify({
        providers: {
          fixture: {
            baseUrl: `http://127.0.0.1:${address.port}/v1`,
            api: 'openai-completions',
            apiKey: 'offline-fixture',
            models: [
              {
                id: 'fixture',
                name: 'Fixture',
                reasoning: false,
                input: ['text'],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: boundedCase ? 22000 : 128000,
                maxTokens: boundedCase && !denseCase ? 2048 : 1024,
              },
            ],
          },
        },
      }),
    );
    writeFileSync(
      join(agent, 'settings.json'),
      JSON.stringify({ 'pi-remembrancer': { autoCapture: true } }),
    );
    const file = join(dir, 'outgoing.jsonl');
    let transcript = [
      JSON.stringify({ type: 'session', id: 'outgoing', cwd: dir }),
      JSON.stringify({
        type: 'message',
        id: 'promise',
        parentId: null,
        message: { role: 'user', content: 'I will send Maya the comparison.' },
      }),
      '',
    ].join('\n');
    if (outcome === 'large') {
      const records: object[] = [
        { type: 'session', id: 'outgoing', cwd: dir },
        {
          type: 'message',
          id: 'unicode',
          parentId: null,
          message: { role: 'user', content: '😀\\"\n'.repeat(1000) },
        },
      ];
      let parentId = 'unicode';
      for (let index = 0; index < 8; index++) {
        const id = 'intent' + index;
        records.push({
          type: 'message',
          id,
          parentId,
          message: { role: 'user', content: 'accepted:task' + index + '|Do task ' + index },
        });
        parentId = id;
      }
      for (let index = 0; index < 6; index++) {
        const id = 'correction' + index;
        records.push({
          type: 'message',
          id,
          parentId,
          message: { role: 'user', content: 'correction:task0|Correction ' + index },
        });
        parentId = id;
      }
      transcript = records.map((record) => JSON.stringify(record)).join('\n') + '\n';
    }
    if (outcome === 'aliases') {
      transcript =
        [
          { type: 'session', id: 'outgoing', cwd: dir },
          {
            type: 'message',
            id: 'promise',
            parentId: null,
            message: { role: 'user', content: 'I will send Maya the comparison.' },
          },
          ...Array.from({ length: 40 }, (_, index) => ({
            type: 'message',
            id: `leaf${index}`,
            parentId: 'promise',
            message: { role: 'assistant', content: 'Context only' },
          })),
        ]
          .map((row) => JSON.stringify(row))
          .join('\n') + '\n';
    }
    if (denseCase) {
      transcript =
        [
          { type: 'session', id: 'outgoing', cwd: dir },
          {
            type: 'message',
            id: 'dense',
            parentId: null,
            message: {
              role: 'user',
              content: Array.from(
                { length: 8 },
                (_, index) => `accepted:t${index}|Do${index};`,
              ).join(''),
            },
          },
        ]
          .map((row) => JSON.stringify(row))
          .join('\n') + '\n';
    }
    const growingParts = Array.from({ length: 35 }, (_, index) =>
      String.fromCharCode(65 + (index % 26)).repeat(120),
    );
    if (outcome === 'growing') {
      transcript =
        [
          { type: 'session', id: 'outgoing', cwd: dir },
          ...growingParts.map((part, index) => ({
            type: 'message',
            id: `grow${index}`,
            parentId: index ? `grow${index - 1}` : null,
            message: {
              role: 'user',
              content: `${index ? 'correction' : 'accepted'}:growing|${part}`,
            },
          })),
          ...['left', 'right'].map((id) => ({
            type: 'message',
            id,
            parentId: 'grow34',
            message: { role: 'user', content: `correction:growing|${id}` },
          })),
        ]
          .map((row) => JSON.stringify(row))
          .join('\n') + '\n';
    }
    writeFileSync(file, transcript);
    const db = new CheckpointStore();
    try {
      const runtime = await ModelRuntime.create({
        authPath: join(agent, 'auth.json'),
        modelsPath: join(agent, 'models.json'),
      });
      const model = runtime.getModel('fixture', 'fixture');
      expect(model).toBeDefined();
      const ctx = {
        cwd: dir,
        mode: 'tui',
        model,
        isProjectTrusted: () => false,
        sessionManager: { getSessionFile: () => file, getSessionId: () => 'outgoing' },
      } as unknown as ExtensionContext;
      const inbox = join(dir, 'inbox');
      await preserveHandoff({
        id: 'first',
        inbox,
        source: { file, sessionId: 'outgoing' },
        execution: captureExecution(ctx),
      });
      await runCaptureWorker({ database: db.file, inbox });
      // Only a later, due wake may consume another whole-review attempt.
      if (boundedCase && covered) expect(requests.length).toBeGreaterThan(3);
      else expect(requests).toHaveLength(expectedRequests);
      expect(db.captureJob('first')).toMatchObject({
        attemptCount: 1,
        retryEligible: outcome === 'provider-error',
      });
      expect(db.reviewed()).toHaveLength(
        covered ? (outcome === 'aliases' ? 40 : outcome === 'growing' ? 2 : 1) : 0,
      );
      expect(db.proposals()).toHaveLength(
        outcome === 'large' || outcome === 'dense' ? 8 : covered && outcome !== 'empty' ? 1 : 0,
      );
      if (outcome === 'aliases') {
        expect(aliasInspected).toBe(true);
        expect(new Set(db.proposals()[0]!.sources.map((source) => source.branchId)).size).toBe(40);
      }
      if (outcome === 'dense') expect(continuations).toBe(7);
      if (outcome === 'growing') {
        expect(valuePages).toBeGreaterThan(1);
        expect(valueText.join('')).toBe(growingParts.slice(0, 3).join(''));
        expect(db.proposals()[0]!.change).toMatchObject({
          fields: { description: growingParts.join('') + 'left' },
        });
        expect(db.proposals()[0]!.question).toBeTruthy();
      }
      if (aggregateCase) {
        expect(Buffer.byteLength(JSON.stringify(task))).toBeGreaterThan(2770);
        const steps = requests.map(
          (request) =>
            JSON.parse(
              providerInstruction(request['messages'] as Parameters<typeof providerInstruction>[0])
                .split('\n')
                .at(-1)!,
            ).work,
        );
        const discovered = steps.find((work) => work.catalogue)?.catalogue[0];
        expect(discovered.identity.description).toBe(task.description);
        const candidate = steps.find((work) => work.candidate)?.candidate;
        expect(outcome === 'aggregate-object' ? candidate : candidate.annotations).toEqual({
          valueHandle: expect.any(String),
        });
        // Every small field behind the aggregate was read exactly, not summarized away.
        for (const [path, value] of taskFields) {
          const original = path
            .split('.')
            .reduce<unknown>((node, key) => (node as Record<string, unknown>)[key], task);
          expect(value).toEqual(original);
        }
        expect(taskFields.size).toBe(outcome === 'aggregate-object' ? 134 : 93);
        expect(db.proposals()[0]!.change).toMatchObject({
          operation: 'update',
          targetUuid: task.uuid,
        });
        expect(db.proposals()[0]!.expected).toEqual(snapshot(task));
      }
      if (outcome === 'renamed') {
        expect(db.proposals()[0]!.change).toMatchObject({
          operation: 'update',
          targetUuid: task.uuid,
        });
        expect(db.proposals()[0]!.expected?.annotations).toEqual(task.annotations);
        expect(db.proposals()[0]!.expected?.fields.description).toBe(task.description);
        expect(JSON.stringify(requests)).not.toContain(task.annotations[0]!.description);
      }
      if (boundedCase) {
        expect(largestOutput).toBeLessThan(denseCase ? 1024 : 2048);
        expect(
          requests.every(
            (request) =>
              Buffer.byteLength(JSON.stringify(request)) < getReviewerBudget(model!).maxInputTokens,
          ),
        ).toBe(true);
        const inputs = requests.map((request) =>
          stepWork(
            providerInstruction(request['messages'] as Parameters<typeof providerInstruction>[0]),
          ),
        );
        if (outcome === 'dense')
          expect(
            new Set(inputs.filter((work) => work.range).map((work) => JSON.stringify(work.range)))
              .size,
          ).toBe(1);
        if (outcome === 'aliases')
          expect(
            inputs.filter((work) => work.range?.occurrences[0]?.entryId === 'promise'),
          ).toHaveLength(2); // Extraction plus explicit alias lookup, not forty primary reads.
        if (outcome === 'growing')
          expect(JSON.stringify(inputs)).not.toContain(growingParts.join(''));
      }
      expect(db.captureJob('first')?.state).toBe(covered ? 'completed' : 'failed');
      expect(requests.every((request) => request['model'] === 'fixture')).toBe(true);
      expect(JSON.stringify(requests)).not.toContain(sentinel);
      expect(readFileSync(file, 'utf8')).toBe(transcript);
      const tools = requests[0]!['tools'] as { function: { name: string } }[];
      expect(tools.map((tool) => tool.function.name)).toEqual(['remembrancer_step']);
      if (outcome === 'large') {
        expect(
          requests.every(
            (request) =>
              Buffer.byteLength(JSON.stringify(request)) < getReviewerBudget(model!).maxInputTokens,
          ),
        ).toBe(true);
        const ranges = requests
          .map(
            (request) =>
              stepWork(
                providerInstruction(
                  request['messages'] as Parameters<typeof providerInstruction>[0],
                ),
              ).range,
          )
          .filter((range): range is NonNullable<typeof range> => range !== undefined);
        expect(
          ranges
            .filter((range) => range.occurrences[0]!.entryId === 'unicode')
            .map((range) => range.text)
            .join(''),
        ).toBe('😀\\"\n'.repeat(1000));
        expect(
          requests.every((request) => !JSON.stringify(request).includes('"proposals":[')),
        ).toBe(true);
        expect(
          requests.every((request) =>
            (request['messages'] as { role: string }[]).every(
              (message) => message.role !== 'assistant' && message.role !== 'tool',
            ),
          ),
        ).toBe(true);
      } else if (!boundedCase) expect(JSON.stringify(requests[0])).toContain('I will send Maya');
    } finally {
      db.close();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      vi.unstubAllEnvs();
      rmSync(dir, { recursive: true, force: true });
    }
  },
  60_000,
);

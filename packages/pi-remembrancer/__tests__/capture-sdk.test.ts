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
import { lookupTasks } from '../extensions/remembrancer/taskwarrior.js';
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
    vi.mocked(lookupTasks).mockResolvedValue({ tasks: [], nextOffset: null });
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
      const args = {
        result: {
          answer: captureAnswer(instruction, outcome !== 'proposal' && outcome !== 'large'),
        },
      };
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(
        `data: ${JSON.stringify({ id: 'offline', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: names.map((name, index) => ({ index, id: `call-${requests.length}-${index}`, type: 'function', function: { name, arguments: JSON.stringify(args) } })) }, finish_reason: null }] })}\n\n`,
      );
      response.write(
        `data: ${JSON.stringify({ id: 'offline', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta: {}, finish_reason: outcome === 'overflow' ? 'length' : names.length ? 'tool_calls' : 'stop' }] })}\n\n`,
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
                contextWindow: outcome === 'large' ? 22000 : 128000,
                maxTokens: outcome === 'large' ? 2048 : 1024,
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
      if (outcome === 'large') expect(requests.length).toBeGreaterThan(50);
      else expect(requests).toHaveLength(expectedRequests);
      expect(db.captureJob('first')).toMatchObject({
        attemptCount: 1,
        retryEligible: outcome === 'provider-error',
      });
      expect(db.reviewed()).toHaveLength(covered ? 1 : 0);
      expect(db.proposals()).toHaveLength(outcome === 'large' ? 8 : outcome === 'proposal' ? 1 : 0);
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
      } else expect(JSON.stringify(requests[0])).toContain('I will send Maya');
    } finally {
      db.close();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      vi.unstubAllEnvs();
      rmSync(dir, { recursive: true, force: true });
    }
  },
  30_000,
);

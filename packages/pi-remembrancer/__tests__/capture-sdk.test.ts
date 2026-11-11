import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModelRuntime, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { expect, it, vi } from 'vitest';
import { captureOutgoing, CAPTURE_BUDGET_MS } from '../extensions/remembrancer/capture.js';
import { CheckpointStore } from '../extensions/remembrancer/checkpoints.js';

// Exercise ordinary SDK startup and its real tool loop against a deterministic local transport.
// No provider adapter, credentials, external requests or Taskwarrior commands.
it.each([
  { outcome: 'empty', requests: 2, covered: true },
  { outcome: 'proposal', requests: 2, covered: true },
  { outcome: 'mixed', requests: 2, covered: false },
  { outcome: 'duplicate', requests: 2, covered: false },
  { outcome: 'unread', requests: 1, covered: false },
  { outcome: 'missing', requests: 1, covered: false },
  { outcome: 'overflow', requests: 1, covered: false },
  { outcome: 'tool-error', requests: 1, covered: false },
  { outcome: 'provider-error', requests: 1, covered: false },
])(
  'installed SDK capture outcome=$outcome',
  async ({ outcome, requests: expectedRequests, covered }) => {
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
    const proposal = {
      change: {
        operation: 'add',
        fields: { description: 'Send Maya the comparison' },
        annotations: [],
      },
      expected: null,
      question: null,
      explanation: 'User promise',
      references: [
        {
          sessionId: 'outgoing',
          branchId: 'promise',
          entryId: 'promise',
          editId: null,
          offset: 0,
          quote: 'I will send Maya',
        },
      ],
    };
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
              : requests.length === 1
                ? ['remembrancer_read_evidence']
                : outcome === 'mixed'
                  ? ['remembrancer_read_evidence', 'remembrancer_submit']
                  : outcome === 'duplicate'
                    ? ['remembrancer_submit', 'remembrancer_submit']
                    : ['remembrancer_submit'];
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(
        `data: ${JSON.stringify({ id: 'offline', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: names.map((name, index) => ({ index, id: `call-${requests.length}-${index}`, type: 'function', function: { name, arguments: name === 'remembrancer_submit' ? JSON.stringify({ proposals: outcome === 'proposal' ? [proposal] : [] }) : name === 'remembrancer_tasks' ? '{"uuid":"all delete"}' : '{}' } })) }, finish_reason: null }] })}\n\n`,
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
                contextWindow: 128000,
                maxTokens: 1024,
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
    const transcript = [
      JSON.stringify({ type: 'session', id: 'outgoing', cwd: dir }),
      JSON.stringify({
        type: 'message',
        id: 'promise',
        parentId: null,
        message: { role: 'user', content: 'I will send Maya the comparison.' },
      }),
      '',
    ].join('\n');
    writeFileSync(file, transcript);
    const db = new CheckpointStore();
    const notify = vi.fn();
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
        ui: { notify },
        sessionManager: { getSessionFile: () => file, getSessionId: () => 'outgoing' },
      } as unknown as ExtensionContext;
      await captureOutgoing(ctx, () => db, Date.now() + CAPTURE_BUDGET_MS);
      expect(requests).toHaveLength(expectedRequests);
      expect(db.reviewed()).toHaveLength(covered ? 1 : 0);
      expect(db.proposals()).toHaveLength(outcome === 'proposal' ? 1 : 0);
      expect(notify).toHaveBeenCalledTimes(covered ? 0 : 1);
      if (!covered)
        expect(notify).toHaveBeenCalledWith(expect.stringContaining('outgoing'), 'warning');
      expect(requests.every((request) => request['model'] === 'fixture')).toBe(true);
      expect(JSON.stringify(requests)).not.toContain(sentinel);
      expect(readFileSync(file, 'utf8')).toBe(transcript);
      const tools = requests[0]!['tools'] as { function: { name: string } }[];
      expect(tools.map((tool) => tool.function.name).sort()).toEqual([
        'remembrancer_context',
        'remembrancer_proposals',
        'remembrancer_read_evidence',
        'remembrancer_submit',
        'remembrancer_tasks',
      ]);
      expect(JSON.stringify(requests[0])).not.toContain('I will send Maya');
      if (expectedRequests > 1) expect(JSON.stringify(requests[1])).toContain('I will send Maya');
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

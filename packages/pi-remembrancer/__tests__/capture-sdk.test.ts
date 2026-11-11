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
it.each([false, true])(
  'installed SDK capture, mixed submission batch=%s',
  async (mixed) => {
    const dir = mkdtempSync(join(tmpdir(), 'capture-sdk-'));
    const agent = join(dir, 'agent');
    mkdirSync(agent);
    const requests: Record<string, unknown>[] = [];
    const server = createServer(async (request, response) => {
      let body = '';
      for await (const chunk of request) body += chunk;
      requests.push(JSON.parse(body));
      const names =
        requests.length === 1
          ? ['remembrancer_read_evidence']
          : mixed
            ? ['remembrancer_read_evidence', 'remembrancer_submit']
            : ['remembrancer_submit'];
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(
        `data: ${JSON.stringify({ id: 'offline', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: names.map((name, index) => ({ index, id: `call-${requests.length}-${index}`, type: 'function', function: { name, arguments: name === 'remembrancer_submit' ? '{"proposals":[]}' : '{}' } })) }, finish_reason: null }] })}\n\n`,
      );
      response.write(
        `data: ${JSON.stringify({ id: 'offline', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\n`,
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
      expect(requests).toHaveLength(2);
      expect(db.reviewed()).toHaveLength(mixed ? 0 : 1);
      expect(db.proposals()).toEqual([]);
      expect(notify).toHaveBeenCalledTimes(mixed ? 1 : 0);
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
      expect(JSON.stringify(requests[1])).toContain('I will send Maya');
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

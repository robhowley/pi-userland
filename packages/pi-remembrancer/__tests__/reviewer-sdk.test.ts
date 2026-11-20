import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModelRuntime, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import { expect, it } from 'vitest';
import {
  estimateReviewerTokens,
  getReviewerBudget,
  ReviewerBudgetError,
  runReviewer,
  runReviewerStep,
  type ReviewerInput,
} from '../extensions/remembrancer/reviewer.js';

// Real isolated SDK sessions, deterministic loopback transport, synthetic evidence only.
async function withProvider(
  options: { contextWindow?: number; truncate?: boolean } = {},
  test: (fixture: {
    input: ReviewerInput;
    requests: Record<string, unknown>[];
    toolCalls: string[];
  }) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'reviewer-sdk-'));
  const agentDir = join(dir, 'agent');
  mkdirSync(agentDir);
  const requests: Record<string, unknown>[] = [];
  const toolCalls: string[] = [];
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    requests.push(JSON.parse(body));
    // The guard makes a broken loop test terminate even if the host stops bounding it.
    const callTool = requests.length < 30;
    const delta = callTool
      ? {
          role: 'assistant',
          tool_calls: [
            {
              index: 0,
              id: `call-${requests.length}`,
              type: 'function',
              function: { name: 'lookup', arguments: JSON.stringify({ handle: 'frozen-range' }) },
            },
          ],
        }
      : { role: 'assistant', content: 'fixture guard' };
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const [value, finishReason] of [
      [delta, null],
      [{}, options.truncate ? 'length' : callTool ? 'tool_calls' : 'stop'],
    ]) {
      response.write(
        `data: ${JSON.stringify({ id: 'offline', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta: value, finish_reason: finishReason }] })}\n\n`,
      );
    }
    response.end('data: [DONE]\n\n');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing fixture port');
    writeFileSync(
      join(agentDir, 'models.json'),
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
                contextWindow: options.contextWindow ?? 12_000,
                maxTokens: 512,
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
    const model = runtime.getModel('fixture', 'fixture');
    if (!model) throw new Error('Missing fixture model');
    const tool: ToolDefinition = {
      name: 'lookup',
      label: 'lookup',
      description: 'Read this frozen evidence handle only',
      parameters: {
        type: 'object',
        properties: { handle: { type: 'string' } },
        required: ['handle'],
      } as ToolDefinition['parameters'],
      async execute(_id, args) {
        toolCalls.push((args as { handle: string }).handle);
        return { content: [{ type: 'text', text: 'Synthetic context. '.repeat(60) }], details: {} };
      },
    };
    await test({
      input: {
        cwd: dir,
        agentDir,
        model,
        modelRuntime: runtime,
        sessionId: 'synthetic',
        tools: [tool],
      },
      requests,
      toolCalls,
    });
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    rmSync(dir, { recursive: true, force: true });
  }
}

it('hands off after one tool batch and starts fitted fresh sessions with host-selected state', async () => {
  await withProvider({}, async ({ input, requests, toolCalls }) => {
    for (let index = 0; index < 8; index++) {
      const result = await runReviewerStep({
        ...input,
        instruction: `Read only range-${index}. Working state: ${index}. 😀`,
      });
      expect(result.status).toBe('handoff');
      expect(result.message.content).toContainEqual(
        expect.objectContaining({ type: 'toolCall', name: 'lookup' }),
      );
      expect(requests).toHaveLength(index + 1);
      const serialized = JSON.stringify(requests[index]);
      expect(serialized).toContain(`range-${index}`);
      if (index > 0) expect(serialized).not.toContain(`range-${index - 1}`);
      expect(serialized).not.toContain('Synthetic context.');
      expect(estimateReviewerTokens(requests[index])).toBeLessThanOrEqual(
        getReviewerBudget(input.model!).maxInputTokens,
      );
      expect(
        (requests[index]!['tools'] as { function: { name: string } }[]).map(
          (tool) => tool.function.name,
        ),
      ).toEqual(['lookup']);
    }
    expect(toolCalls).toHaveLength(8);
  });
});

it('bounds the existing reviewer tool loop without silently completing or sending oversized history', async () => {
  await withProvider({}, async ({ input, requests, toolCalls }) => {
    await expect(runReviewer(input)).rejects.toBeInstanceOf(ReviewerBudgetError);
    expect(requests.length).toBeGreaterThan(1);
    expect(requests.length).toBeLessThan(15);
    expect(toolCalls.length).toBeLessThanOrEqual(requests.length);
    for (const request of requests)
      expect(estimateReviewerTokens(request)).toBeLessThanOrEqual(
        getReviewerBudget(input.model!).maxInputTokens,
      );
  });
});

it('fails on an indivisible oversized lookup without a follow-up request', async () => {
  await withProvider({}, async ({ input, requests }) => {
    const tool = input.tools[0]!;
    await expect(
      runReviewerStep({
        ...input,
        tools: [
          {
            ...tool,
            async execute() {
              return { content: [{ type: 'text', text: '😀'.repeat(12_000) }], details: {} };
            },
          },
        ],
        instruction: 'Read one piece',
      }),
    ).rejects.toBeInstanceOf(ReviewerBudgetError);
    expect(requests).toHaveLength(1);
  });
});

it('rejects truncated output before executing even a parseable tool call', async () => {
  await withProvider({ truncate: true }, async ({ input, requests, toolCalls }) => {
    await expect(runReviewerStep({ ...input, instruction: 'Read one piece' })).rejects.toThrow(
      /length/,
    );
    expect(requests).toHaveLength(1);
    expect(toolCalls).toEqual([]);
  });
});

it('does not dispatch indivisible input that cannot fit the model', async () => {
  await withProvider({}, async ({ input, requests }) => {
    await expect(
      runReviewerStep({ ...input, instruction: '😀'.repeat(12_000) }),
    ).rejects.toBeInstanceOf(ReviewerBudgetError);
    expect(requests).toEqual([]);
  });
});

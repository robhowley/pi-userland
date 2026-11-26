import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModelRuntime, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import { expect, it } from 'vitest';
import { writeCompletion } from './fixtures/openai-loopback.js';
import {
  estimateReviewerTokens,
  getReviewerBudget,
  ReviewerBudgetError,
  runReviewer,
  type ContinuingReviewerInput,
} from '../extensions/remembrancer/reviewer.js';

// Real isolated SDK sessions, deterministic loopback transport, synthetic evidence only.
async function withProvider(
  options: {
    contextWindow?: number;
    truncate?: boolean;
    reply?: string;
    toolName?: string;
    submitAfter?: number;
  } = {},
  test: (fixture: {
    input: ContinuingReviewerInput;
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
    request.setEncoding('utf8');
    let body = '';
    for await (const chunk of request) body += chunk;
    requests.push(JSON.parse(body));
    // The guard makes a broken loop test terminate even if the host stops bounding it.
    const callTool = options.reply === undefined && requests.length < 30;
    const delta = callTool
      ? {
          role: 'assistant',
          tool_calls: [
            {
              index: 0,
              id: `call-${requests.length}`,
              type: 'function',
              function: {
                name:
                  options.toolName ??
                  (requests.length > (options.submitAfter ?? 30)
                    ? 'remembrancer_submit'
                    : 'lookup'),
                arguments: JSON.stringify(
                  requests.length > (options.submitAfter ?? 30) ? {} : { handle: 'frozen-range' },
                ),
              },
            },
          ],
        }
      : { role: 'assistant', content: options.reply ?? 'fixture guard' };
    writeCompletion(
      response,
      delta,
      options.truncate ? 'length' : callTool ? 'tool_calls' : 'stop',
    );
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
        instruction: 'Read frozen evidence, inspect existing records, then submit once alone.',
        tools: [
          tool,
          {
            name: 'remembrancer_submit',
            label: 'Submit',
            description: 'Terminal finalized result',
            parameters: { type: 'object', properties: {} } as ToolDefinition['parameters'],
            async execute() {
              return {
                content: [{ type: 'text', text: 'accepted' }],
                details: {},
                terminate: true,
              };
            },
          },
        ],
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

it('retains all tool history in one session until the reviewer submits once alone', async () => {
  await withProvider(
    { contextWindow: 64_000, submitAfter: 3 },
    async ({ input, requests, toolCalls }) => {
      await expect(runReviewer(input)).resolves.toBeUndefined();
      expect(requests).toHaveLength(4);
      expect(toolCalls).toEqual(['frozen-range', 'frozen-range', 'frozen-range']);
      for (const [index, request] of requests.entries()) {
        const messages = request['messages'] as { role: string }[];
        expect(messages.filter((message) => message.role === 'user')).toHaveLength(1);
        expect(messages.filter((message) => message.role === 'tool')).toHaveLength(index);
        expect(messages.filter((message) => message.role === 'assistant')).toHaveLength(index);
        expect(JSON.stringify(request)).toContain(input.instruction);
        if (index) expect(JSON.stringify(request)).toContain('Synthetic context.');
        expect(estimateReviewerTokens(request)).toBeLessThanOrEqual(
          getReviewerBudget(input.model!).maxInputTokens,
        );
        expect(
          (request['tools'] as { function: { name: string } }[]).map((tool) => tool.function.name),
        ).toEqual(['lookup', 'remembrancer_submit']);
      }
    },
  );
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
      runReviewer({
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
    await expect(runReviewer(input)).rejects.toThrow(/length/);
    expect(requests).toHaveLength(1);
    expect(toolCalls).toEqual([]);
  });
});

it('rejects an unknown tool by name without executing a current handler or requesting another turn', async () => {
  await withProvider({ toolName: 'retired_lookup' }, async ({ input, requests, toolCalls }) => {
    await expect(runReviewer(input)).rejects.toThrow(
      /Reviewer tool failed \(retired_lookup\):.*not found/,
    );
    expect(requests).toHaveLength(1);
    expect(toolCalls).toEqual([]);
  });
});

it('passes preflight but rejects the complete SDK-framed provider request before HTTP', async () => {
  await withProvider({ contextWindow: 4096 }, async ({ input, requests, toolCalls }) => {
    await expect(runReviewer({ ...input, instruction: 'x'.repeat(1800) })).rejects.toMatchObject({
      name: 'ReviewerBudgetError',
      message: expect.stringMatching(/^Reviewer complete provider request exceeds context budget/),
    });
    expect(requests).toEqual([]);
    expect(toolCalls).toEqual([]);
  });
});

it('rejects prose-only completion rather than treating it as a submission', async () => {
  await withProvider({ reply: 'Finished reviewing.' }, async ({ input, requests, toolCalls }) => {
    await expect(runReviewer(input)).rejects.toThrow('did not submit a terminal result');
    expect(requests).toHaveLength(1);
    expect(toolCalls).toEqual([]);
  });
});

it('rejects oversized assistant output even when the provider ignores max_tokens', async () => {
  await withProvider({ reply: 'x'.repeat(2000) }, async ({ input, requests }) => {
    await expect(runReviewer(input)).rejects.toBeInstanceOf(ReviewerBudgetError);
    expect(requests).toHaveLength(1);
  });
});

it('does not dispatch indivisible input that cannot fit the model', async () => {
  await withProvider({}, async ({ input, requests }) => {
    await expect(
      runReviewer({ ...input, instruction: '😀'.repeat(12_000) }),
    ).rejects.toBeInstanceOf(ReviewerBudgetError);
    expect(requests).toEqual([]);
  });
});

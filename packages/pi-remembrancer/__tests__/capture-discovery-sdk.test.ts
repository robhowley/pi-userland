import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { ModelRuntime, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { expect, it, vi } from 'vitest';
import { preserveHandoff } from '../extensions/remembrancer/capture-handoff.js';
import { runCaptureWorker } from '../extensions/remembrancer/capture-worker.js';
import { CAPTURE_BUDGET_MS } from '../extensions/remembrancer/capture.js';
import { captureExecution } from '../extensions/remembrancer/config.js';
import { CheckpointStore } from '../extensions/remembrancer/checkpoints.js';
import { getReviewerBudget } from '../extensions/remembrancer/reviewer-budget.js';
import { readTaskCatalog } from '../extensions/remembrancer/taskwarrior.js';
import { captureAnswer, providerInstruction } from './fixtures/capture-steps.js';

vi.mock('../extensions/remembrancer/taskwarrior.js', async (original) => ({
  ...(await original<typeof import('../extensions/remembrancer/taskwarrior.js')>()),
  readTaskCatalog: vi.fn(),
}));

// Real worker, SDK tool loop, atomic publication and disposable HTTP transport.
// These deterministic identity choices measure orchestration, not model recall/latency.
it.each(['representative', 'plausible', 'truncated', 'existing-truncated'])(
  'bounded populated discovery through SDK: %s',
  async (scenario) => {
    const dir = mkdtempSync(join(tmpdir(), 'capture-discovery-sdk-'));
    const agent = join(dir, 'agent');
    mkdirSync(agent);
    vi.stubEnv('PI_CODING_AGENT_DIR', agent);
    vi.stubEnv('XDG_STATE_HOME', dir);
    vi.mocked(readTaskCatalog).mockResolvedValue([]);
    const count = scenario === 'representative' ? 24 : 90;
    let phase: 'seed' | 'review' = 'seed';
    let truncated = false;
    let requestsAfterTruncation = 0;
    let largestOutput = 0;
    const counts = {
      extraction: 0,
      discovery: 0,
      recordMatch: 0,
      fold: 0,
      existingDiscovery: 0,
      exact: 0,
      fields: 0,
      materialize: 0,
      other: 0,
    };
    const supportingText = 'nonidentity supporting detail '.repeat(200);
    const savedExplanation = 'Saved explanation detail '.repeat(180);
    const detailRead = new Map<string, { explanation: string; quote: string }>();
    const exactHandles = new Set<string>();
    const existingSeen = new Map<string, Set<string>>();
    const recordSeen = new Set<string>();
    const recordEntries = new Map<string, object>();
    let finalObservation: object | undefined;
    const existingEntries = new Map<string, object>();
    const outputPages: { kind: string; ids: string[]; bytes: number }[] = [];
    const inputs: number[] = [];
    const server = createServer(async (request, response) => {
      let raw = '';
      for await (const chunk of request) raw += chunk;
      if (truncated) requestsAfterTruncation++;
      const body = JSON.parse(raw);
      const instruction = providerInstruction(body.messages);
      const work = JSON.parse(instruction.slice(instruction.lastIndexOf('\n') + 1)).work;
      let answer = captureAnswer(instruction);
      let category: keyof typeof counts = 'other';
      if (work.range) category = 'extraction';
      else if (work.catalogue) {
        const existing = Boolean(work.catalogue[0]?.handle);
        category = existing ? 'existingDiscovery' : 'discovery';
        let ids: string[] = [];
        if (phase === 'review') {
          if (existing) {
            const seen = existingSeen.get(work.state.summary) ?? new Set<string>();
            work.catalogue.forEach((item: { handle: string }) => {
              seen.add(item.handle);
              existingEntries.set(item.handle, item);
            });
            existingSeen.set(work.state.summary, seen);
          } else if (work.observation.label === `task${count - 1}`) {
            finalObservation = work.observation;
            work.catalogue.forEach((item: { id: string }) => {
              recordSeen.add(item.id);
              recordEntries.set(item.id, item);
            });
          }
          ids = work.catalogue
            .filter((item: { identity?: unknown }) => {
              if (scenario !== 'representative')
                return existing
                  ? work.state.summary === `task${count - 1}`
                  : work.observation.label === `task${count - 1}`;
              if (!existing) return false;
              const identity = item.identity as {
                description?: string;
                effective?: { change: { fields: { description: string } } };
              };
              return (
                (identity.description ?? identity.effective?.change.fields.description) ===
                work.state.draft.change.fields.description
              );
            })
            .map((item: { id: string; handle?: string }) => (existing ? item.handle! : item.id));
          outputPages.push({
            kind: category,
            ids,
            bytes: Buffer.byteLength(JSON.stringify({ result: { answer: { candidates: ids } } })),
          });
        }
        answer = { candidates: ids };
      } else if (instruction.includes('All exact candidate fields')) {
        category = 'exact';
        if (phase === 'review') exactHandles.add(work.handle);
        const candidate = work.candidate;
        const same =
          scenario === 'representative' &&
          (candidate.description ?? candidate.effective?.change.fields.description) ===
            work.state.draft.change.fields.description;
        answer = { match: same ? 'same' : 'different' };
      } else if (work.candidate) category = 'recordMatch';
      else if (work.observation) category = 'fold';
      else if (work.page) {
        category = 'fields';
        if (phase === 'review') {
          const read = detailRead.get(work.handle) ?? { explanation: '', quote: '' };
          if (work.page.path.join('.') === 'explanation') read.explanation += work.page.text;
          if (work.page.path.join('.') === 'sources.0.quote') read.quote += work.page.text;
          detailRead.set(work.handle, read);
        }
      } else if (instruction.includes('Materialize')) {
        category = 'materialize';
        if (phase === 'review' && scenario === 'representative') {
          const draft = work.targetUuid
            ? {
                change: {
                  operation: 'update',
                  targetUuid: work.targetUuid,
                  fields: { priority: 'H' },
                  annotations: [],
                },
                question: null,
              }
            : (work.matchedProposals[0]?.effective ?? work.state.draft);
          answer = {
            reason: 'Use unique matched identity',
            submission: { ...draft, explanation: 'Exact fixture evidence' },
          };
        }
        if (phase === 'seed' && scenario === 'representative') {
          const result = answer as { submission: { explanation: string } };
          result.submission.explanation = savedExplanation;
        }
      }
      if (phase === 'review') {
        counts[category]++;
        inputs.push(
          Buffer.byteLength(JSON.stringify({ messages: body.messages, tools: body.tools })),
        );
      }
      const args = { result: { answer } };
      if (phase === 'review')
        largestOutput = Math.max(largestOutput, Buffer.byteLength(JSON.stringify(args)));
      const fail =
        phase === 'review' &&
        ((scenario === 'truncated' &&
          category === 'discovery' &&
          work.observation.label === `task${count - 1}`) ||
          (scenario === 'existing-truncated' &&
            category === 'existingDiscovery' &&
            work.state.summary === `task${count - 1}` &&
            work.catalogue.some((item: { handle: string }) =>
              item.handle.startsWith('proposal:'),
            )));
      truncated ||= fail;
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(
        `data: ${JSON.stringify({
          id: 'offline',
          object: 'chat.completion.chunk',
          created: 1,
          model: 'fixture',
          choices: [
            {
              index: 0,
              delta: {
                role: 'assistant',
                tool_calls: [
                  {
                    index: 0,
                    id: 'call',
                    type: 'function',
                    function: { name: 'remembrancer_step', arguments: JSON.stringify(args) },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        })}\n\n`,
      );
      response.write(
        `data: ${JSON.stringify({
          id: 'offline',
          object: 'chat.completion.chunk',
          created: 1,
          model: 'fixture',
          choices: [{ index: 0, delta: {}, finish_reason: fail ? 'length' : 'tool_calls' }],
        })}\n\n`,
      );
      response.end('data: [DONE]\n\n');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing fixture address');
    writeFileSync(
      join(agent, 'models.json'),
      JSON.stringify({
        providers: {
          fixture: {
            baseUrl: `http://127.0.0.1:${address.port}/v1`,
            api: 'openai-completions',
            apiKey: 'offline',
            models: [
              {
                id: 'seed',
                name: 'Seed fixture',
                reasoning: false,
                input: ['text'],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 524288,
                maxTokens: 8192,
              },
              {
                id: 'fixture',
                name: 'Fixture',
                reasoning: false,
                input: ['text'],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: scenario === 'representative' ? 128000 : 524288,
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
    const db = new CheckpointStore();
    try {
      const runtime = await ModelRuntime.create({
        authPath: join(agent, 'auth.json'),
        modelsPath: join(agent, 'models.json'),
      });
      const model = runtime.getModel('fixture', 'fixture')!;
      const inbox = join(dir, 'inbox');
      async function capture(id: string, labels: string[], descriptions: string[]) {
        const file = join(dir, `${id}.jsonl`);
        writeFileSync(
          file,
          [
            { type: 'session', id, cwd: dir },
            ...labels.map((label, index) => ({
              type: 'message',
              id: `m${index}`,
              parentId: index ? `m${index - 1}` : null,
              message: {
                role: 'user',
                content: `accepted:${label}|${descriptions[index]}${
                  phase === 'seed' && scenario === 'representative' ? `|${supportingText}` : ''
                }`,
              },
            })),
          ]
            .map((row) => JSON.stringify(row))
            .join('\n') + '\n',
        );
        const ctx = {
          cwd: dir,
          mode: 'tui',
          model:
            phase === 'seed' && scenario === 'representative'
              ? runtime.getModel('fixture', 'seed')!
              : model,
          isProjectTrusted: () => false,
          sessionManager: { getSessionFile: () => file, getSessionId: () => id },
        } as unknown as ExtensionContext;
        await preserveHandoff({
          id,
          inbox,
          source: { file, sessionId: id },
          execution: captureExecution(ctx),
        });
        await runCaptureWorker({ database: db.file, inbox }); // Unchanged production 300s deadline.
      }
      await capture(
        'seed',
        Array.from({ length: 32 }, (_, i) => `saved${i}`),
        Array.from({ length: 32 }, (_, i) => `Work ${i + 12}`),
      );
      expect(db.captureJob('seed')?.state).toBe('completed');
      const before = { proposals: db.proposals(), coverage: db.reviewed() };
      // The first twelve current tasks match, the remainder are unrelated. Saved
      // effective drafts match obligations 12..23, despite different founding labels.
      const tasks = Array.from({ length: 64 }, (_, i) => ({
        uuid: `12345678-1234-1234-1234-${String(i).padStart(12, '0')}`,
        status: i < 12 ? 'pending' : 'completed',
        description: i < 12 ? `Work ${i}` : `Other ${i}`,
      }));
      vi.mocked(readTaskCatalog).mockResolvedValue(tasks);
      phase = 'review';
      const started = performance.now();
      await capture(
        'review',
        Array.from({ length: count }, (_, i) => `task${i}`),
        Array.from({ length: count }, (_, i) => `Work ${i}`),
      );
      const elapsedMs = performance.now() - started;
      expect(CAPTURE_BUDGET_MS).toBe(300000);
      expect(elapsedMs).toBeLessThan(CAPTURE_BUDGET_MS);
      expect(db.captureJob('review')).toMatchObject({
        state: truncated ? 'failed' : 'completed',
        attemptCount: 1,
      });
      expect(inputs.every((bytes) => bytes <= getReviewerBudget(model).maxInputTokens)).toBe(true);
      expect(outputPages.every((page) => page.bytes <= model.maxTokens - 512)).toBe(true);
      expect(largestOutput).toBeLessThan(model.maxTokens);
      if (scenario.endsWith('truncated')) {
        expect(truncated).toBe(true);
        expect(requestsAfterTruncation).toBe(0);
        expect({ proposals: db.proposals(), coverage: db.reviewed() }).toEqual(before);
        expect(counts.recordMatch).toBe(scenario === 'truncated' ? 0 : count - 1); // No per-piece retry.
      } else {
        expect(db.reviewed()).toHaveLength(2);
        expect(existingSeen.size).toBe(count);
        expect([...existingSeen.values()].every((seen) => seen.size === 96)).toBe(true);
        if (scenario === 'representative') {
          expect(counts.fields).toBeGreaterThan(0);
          const savedMatches = before.proposals.slice(0, 12);
          expect(exactHandles).toEqual(
            new Set([
              ...tasks.slice(0, 12).map((_, index) => `task:${index}`),
              ...savedMatches.map((proposal) => `proposal:${proposal.id}`),
            ]),
          );
          expect(detailRead.size).toBe(12);
          for (const proposal of savedMatches) {
            expect(detailRead.get(`proposal:${proposal.id}`)).toEqual({
              explanation: savedExplanation,
              quote: proposal.sources[0]!.quote,
            });
            expect(proposal.sources[0]!.quote).toContain(supportingText);
          }
          expect(counts.exact).toBe(24); // Not 24 * 96 full-detail reads.
          expect(counts.recordMatch).toBe(0);
          expect(db.proposals()).toHaveLength(44); // 12 task updates, 12 saved revisions.
          expect(db.proposals().filter((proposal) => proposal.revision === 2)).toHaveLength(12);
          expect(
            db.proposals().filter((proposal) => proposal.change.operation === 'update'),
          ).toHaveLength(12);
        } else {
          expect(counts.fields).toBe(0);
          expect(recordSeen.size).toBe(count - 1);
          expect(counts.recordMatch).toBe(count - 1);
          expect(counts.exact).toBe(96);
          const limit = Math.floor((getReviewerBudget(model).maxInputTokens - 5000) / 5);
          // Either entire catalogue fits input, but its all-plausible ID answer
          // cannot fit the response. Both must therefore split for output alone.
          for (const [catalogue, observation] of [
            [[...recordEntries.values()], finalObservation],
            [[...existingEntries.values()], undefined],
          ])
            expect(Buffer.byteLength(JSON.stringify({ catalogue, observation }))).toBeLessThan(
              limit,
            );
          expect(
            outputPages.filter((page) => page.kind === 'discovery' && page.ids.length).length,
          ).toBeGreaterThan(1);
          expect(
            outputPages.filter(
              (page) =>
                page.kind === 'existingDiscovery' &&
                page.ids.some((id) => id.startsWith('proposal:')),
            ).length,
          ).toBeGreaterThan(1);
          expect(db.proposalCount()).toBe(32 + count);
        }
      }
      const measurement = {
        measurement: 'disposable-local-provider',
        scenario,
        obligations: count,
        tasks: 64,
        saved: 32,
        maxTokens: model.maxTokens,
        contextWindow: model.contextWindow,
        deadlineMs: CAPTURE_BUDGET_MS,
        elapsedMs: Math.round(elapsedMs),
        counts,
        calls: Object.values(counts).reduce((a, b) => a + b, 0),
        maxInputBytes: Math.max(...inputs),
        maxOutputBytes: largestOutput,
      };
      const report = process.env['REMEMBRANCER_DISCOVERY_REPORT'];
      if (report) writeFileSync(`${report}.${scenario}.json`, JSON.stringify(measurement, null, 2));
    } finally {
      db.close();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      vi.unstubAllEnvs();
      rmSync(dir, { recursive: true, force: true });
    }
  },
  300000,
);

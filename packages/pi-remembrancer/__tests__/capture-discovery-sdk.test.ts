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
import * as captureModule from '../extensions/remembrancer/capture.js';
import { captureExecution } from '../extensions/remembrancer/config.js';
import { CheckpointStore } from '../extensions/remembrancer/checkpoints.js';
import {
  estimateReviewerTokens,
  getReviewerBudget,
} from '../extensions/remembrancer/reviewer-budget.js';
import { readTaskCatalog } from '../extensions/remembrancer/taskwarrior.js';
import type { CaptureSubmission } from '../extensions/remembrancer/capture-submission.js';
import type { Proposal } from '../extensions/remembrancer/proposals.js';
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

// Discovery is reviewer-directed, not a mandatory catalogue scan per commitment.
// These deterministic matches test storage/transport, not model recall or latency.
it.each(['representative', 'plausible', 'truncated', 'existing-truncated'])(
  'bounded populated discovery through continuing SDK: %s',
  async (scenario) => {
    const dir = mkdtempSync(join(tmpdir(), 'capture-discovery-sdk-'));
    const agent = join(dir, 'agent');
    mkdirSync(agent);
    vi.stubEnv('PI_CODING_AGENT_DIR', agent);
    vi.stubEnv('XDG_STATE_HOME', dir);
    vi.mocked(readTaskCatalog).mockReset().mockResolvedValue([]);
    const count = scenario === 'representative' ? 24 : 90;
    const supportingText = 'nonidentity supporting detail '.repeat(200);
    const savedExplanation = 'Saved explanation detail '.repeat(180);
    let phase: 'seed' | 'review' = 'seed';
    let evidence: EvidencePageEntry[] = [];
    let nextPage = 0;
    let stage: 'skill' | 'evidence' | 'tasks' | 'proposals' | 'detail' | 'submit' = 'skill';
    let lastCall: CaptureToolCall | undefined;
    let taskOffset = 0;
    let proposalOffset = 0;
    const seenTasks: { uuid: string; description: string }[] = [];
    const seenProposals: { id: string; revision: number; label: string }[] = [];
    const matchedProposals = () =>
      seenProposals.filter((proposal) =>
        Array.from({ length: 12 }, (_, i) => `Work ${i + 12}`).includes(proposal.label),
      );
    const detailRead = new Map<string, Proposal>();
    const evidenceRead = new Map<string, string>();
    let detailIndex = 0;
    let detailAction: 'detail' | 'evidence' = 'detail';
    let detailRequest: object | undefined;
    let detailText = '';
    let truncated = false;
    let requestsAfterTruncation = 0;
    let fixtureError: unknown;
    const requests: Record<string, unknown>[] = [];
    let reviewStart = 0;
    function submission(): CaptureSubmission {
      const result: CaptureSubmission = { records: [], dispositions: [] };
      const whole = new Map<string, EvidencePageEntry>();
      for (const entry of evidence) {
        const key = JSON.stringify([entry.branchId, entry.entryId, entry.editId]);
        const prior = whole.get(key);
        if (prior) {
          expect(entry.offset).toBe(prior.text.length);
          prior.text += entry.text;
        } else {
          expect(entry.offset).toBe(0);
          whole.set(key, { ...entry });
        }
      }
      for (const [index, entry] of [...whole.values()].entries()) {
        const description = entry.text.split('|')[1]!;
        const task =
          phase === 'review' && scenario === 'representative' && index < 12
            ? seenTasks[index]
            : undefined;
        const saved =
          phase === 'review' && scenario === 'representative' && index >= 12
            ? [...detailRead.values()].find(
                (proposal) =>
                  proposal.change.operation === 'add' &&
                  proposal.change.fields.description === description,
              )
            : undefined;
        const change = task
          ? {
              operation: 'update' as const,
              targetUuid: task.uuid,
              fields: { priority: 'H' as const },
              annotations: [],
            }
          : { operation: 'add' as const, fields: { description }, annotations: [] };
        const candidates: CaptureSubmission['records'][number]['candidates'] = task
          ? [{ kind: 'task', id: task.uuid, judgment: 'same' }]
          : saved
            ? [{ kind: 'proposal', id: saved.id, revision: saved.revision, judgment: 'same' }]
            : [];
        if (scenario !== 'representative' && phase === 'review' && index === whole.size - 1) {
          candidates.push(
            ...seenTasks.map((task) => ({
              kind: 'task' as const,
              id: task.uuid,
              judgment: 'different' as const,
            })),
            ...seenProposals.map((proposal) => ({
              kind: 'proposal' as const,
              id: proposal.id,
              revision: proposal.revision,
              judgment: 'different' as const,
            })),
          );
        }
        const key = `record${index}`;
        result.records.push(
          captureRecord(
            key,
            [{ kind: 'accepted', reference: captureReference(entry) }],
            [
              {
                branchId: entry.branchId,
                state: {
                  summary: description,
                  status: 'active',
                  draft: { change, question: null },
                },
              },
            ],
            { candidates },
          ),
        );
        result.dispositions.push(
          captureDisposition(
            [key],
            {
              change,
              question: null,
              explanation: phase === 'seed' ? savedExplanation : 'Use unique matched identity',
            },
            'Accepted obligation',
          ),
        );
      }
      return result;
    }
    const text = (content: unknown) =>
      typeof content === 'string'
        ? content
        : (content as { text?: string }[]).map((part) => part.text ?? '').join('');
    const server = createServer(async (request, response) => {
      try {
        request.setEncoding('utf8');
        let raw = '';
        for await (const chunk of request) raw += chunk;
        if (truncated) requestsAfterTruncation++;
        const body = JSON.parse(raw);
        requests.push(body);
        const messages = body.messages as { role: string; content: unknown }[];
        const paths = reviewerPaths(
          text(messages.find((message) => message.role === 'user')!.content),
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
          const data = JSON.parse(text(last.content));
          if (lastCall.name === 'remembrancer_read' && stage === 'evidence') {
            for (const { entries, ...group } of data.groups)
              for (const entry of entries) evidence.push({ ...group, ...entry });
            if (!data.hasMore) stage = phase === 'seed' ? 'submit' : 'tasks';
          } else if (lastCall.name === 'remembrancer_tasks') {
            expect(Buffer.byteLength(text(last.content))).toBeLessThanOrEqual(51_200);
            seenTasks.push(...data.tasks);
            taskOffset = data.nextOffset;
            if (data.nextOffset === null) stage = 'proposals';
          } else if (lastCall.name === 'remembrancer_proposals' && stage === 'proposals') {
            seenProposals.push(...data.proposals);
            proposalOffset = data.nextOffset;
            if (data.nextOffset === null)
              stage = scenario === 'representative' ? 'detail' : 'submit';
          } else if (lastCall.name === 'remembrancer_proposals' && stage === 'detail') {
            expect(Buffer.byteLength(text(last.content))).toBeLessThanOrEqual(51_200);
            detailText +=
              detailAction === 'detail'
                ? data.json
                : data.entries.map((entry: { quote: string }) => entry.quote).join('');
            detailRequest = data.next;
            if (!data.next) {
              const id = matchedProposals()[detailIndex]!.id;
              if (detailAction === 'detail') {
                detailRead.set(id, JSON.parse(detailText));
                detailAction = 'evidence';
              } else {
                evidenceRead.set(id, detailText);
                detailIndex++;
                detailAction = 'detail';
              }
              detailText = '';
              detailRequest = undefined;
              if (detailIndex === 12) stage = 'submit';
            }
          }
        }
        let call: CaptureToolCall;
        if (stage === 'skill') {
          // Next response is the full installed skill, deliberately not JSON.
          call = { name: 'remembrancer_read', args: { path: paths.skill } };
          stage = 'evidence';
        } else if (stage === 'evidence')
          call = { name: 'remembrancer_read', args: { path: paths.review, page: nextPage++ } };
        else if (stage === 'tasks')
          call = { name: 'remembrancer_tasks', args: { offset: taskOffset } };
        else if (stage === 'proposals')
          call = { name: 'remembrancer_proposals', args: { offset: proposalOffset } };
        else if (stage === 'detail') {
          const saved = matchedProposals()[detailIndex]!;
          call = {
            name: 'remembrancer_proposals',
            args: detailRequest ?? { action: detailAction, id: saved.id, revision: saved.revision },
          };
        } else call = { name: 'remembrancer_submit', args: submission() };
        const fail =
          phase === 'review' &&
          ((scenario === 'truncated' && call.name === 'remembrancer_tasks') ||
            (scenario === 'existing-truncated' && call.name === 'remembrancer_proposals'));
        truncated ||= fail;
        lastCall = call;
        writeCompletion(
          response,
          captureToolCalls([call], requests.length),
          fail ? 'length' : 'tool_calls',
        );
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
      if (!address || typeof address === 'string') throw new Error('No fixture port');
      writeFileSync(
        join(agent, 'models.json'),
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
                  contextWindow: 4_000_000,
                  maxTokens: 524_288,
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
      const runtime = await ModelRuntime.create({
        authPath: join(agent, 'auth.json'),
        modelsPath: join(agent, 'models.json'),
      });
      const model = runtime.getModel('fixture', 'fixture')!;
      const inbox = join(dir, 'inbox');
      async function capture(id: string, descriptions: string[]) {
        const file = join(dir, `${id}.jsonl`);
        writeFileSync(
          file,
          [
            { type: 'session', id, cwd: dir },
            ...descriptions.map((description, i) => ({
              type: 'message',
              id: `m${i}`,
              parentId: i ? `m${i - 1}` : null,
              message: {
                role: 'user',
                content: `accepted:task${i}|${description}${phase === 'seed' ? `|${supportingText}` : ''}`,
              },
            })),
          ]
            .map((row) => JSON.stringify(row))
            .join('\n') + '\n',
        );
        const ctx = {
          cwd: dir,
          mode: 'tui',
          model,
          isProjectTrusted: () => false,
          sessionManager: { getSessionFile: () => file, getSessionId: () => id },
        } as unknown as ExtensionContext;
        await preserveHandoff({
          id,
          inbox,
          source: { file, sessionId: id },
          execution: captureExecution(ctx),
        });
        const review = vi.spyOn(captureModule, 'reviewPreparedCapture');
        try {
          await runCaptureWorker({ database: db.file, inbox });
          if (fixtureError) throw fixtureError;
          if (db.captureJob(id)?.state === 'failed' && !scenario.endsWith('truncated'))
            await review.mock.results.at(-1)!.value;
          if (phase === 'seed') await review.mock.results.at(-1)!.value;
        } finally {
          review.mockRestore();
        }
      }
      await capture(
        'seed',
        Array.from({ length: 32 }, (_, i) => `Work ${i + 12}`),
      );
      expect(db.captureJob('seed')?.state, db.captureJob('seed')?.diagnostic ?? '').toBe(
        'completed',
      );
      const before = { proposals: db.proposals(), coverage: db.reviewed() };
      const tasks = Array.from({ length: 64 }, (_, i) => ({
        uuid: `12345678-1234-1234-1234-${String(i).padStart(12, '0')}`,
        status: i < 12 ? 'pending' : 'completed',
        description: i < 12 ? `Work ${i}` : `Other ${i}`,
      }));
      vi.mocked(readTaskCatalog).mockResolvedValue(tasks);
      phase = 'review';
      evidence = [];
      nextPage = 0;
      stage = 'skill';
      lastCall = undefined;
      reviewStart = requests.length;
      const start = performance.now();
      await capture(
        'review',
        Array.from({ length: count }, (_, i) => `Work ${i}`),
      );
      expect(CAPTURE_BUDGET_MS).toBe(300_000);
      expect(performance.now() - start).toBeLessThan(CAPTURE_BUDGET_MS);
      expect(db.captureJob('review')).toMatchObject({
        state: truncated ? 'failed' : 'completed',
        attemptCount: 1,
      });
      expect(
        requests.every(
          (request) => estimateReviewerTokens(request) <= getReviewerBudget(model).maxInputTokens,
        ),
      ).toBe(true);
      if (scenario.endsWith('truncated')) {
        expect(truncated).toBe(true);
        expect(requestsAfterTruncation).toBe(0);
        expect({ proposals: db.proposals(), coverage: db.reviewed() }).toEqual(before);
      } else {
        expect(seenTasks).toHaveLength(64);
        expect(seenProposals).toHaveLength(32);
        expect(readTaskCatalog).toHaveBeenCalledOnce(); // One retained matching export, not per-record scans.
        expect(db.reviewed()).toHaveLength(2);
        if (scenario === 'representative') {
          expect(detailRead.size).toBe(12);
          for (const [id, proposal] of detailRead) {
            expect(proposal.explanation).toBe(savedExplanation);
            expect(evidenceRead.get(id)).toBe(
              before.proposals.find((saved) => saved.id === id)!.sources[0]!.quote,
            );
            expect(evidenceRead.get(id)).toContain(supportingText);
          }
          expect(db.proposals()).toHaveLength(44);
          expect(db.proposals().filter((proposal) => proposal.revision === 2)).toHaveLength(12);
          expect(
            db.proposals().filter((proposal) => proposal.change.operation === 'update'),
          ).toHaveLength(12);
        } else expect(db.proposalCount()).toBe(32 + count);
      }
      const reviewRequests = requests.slice(reviewStart);
      expect(JSON.stringify(reviewRequests[0])).not.toContain('Work 12'); // No host catalogue serialization in the opening instruction.
      for (const [index, request] of reviewRequests.entries()) {
        const messages = request['messages'] as { role: string }[];
        expect(messages.filter((message) => message.role === 'user')).toHaveLength(1);
        expect(messages.filter((message) => message.role === 'tool')).toHaveLength(index);
      }
    } finally {
      db.close();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      vi.unstubAllEnvs();
      rmSync(dir, { recursive: true, force: true });
    }
  },
  300_000,
);

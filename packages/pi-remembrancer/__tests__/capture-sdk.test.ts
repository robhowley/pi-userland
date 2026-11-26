import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentSession, ModelRuntime, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { expect, it, vi } from 'vitest';
import { preserveHandoff } from '../extensions/remembrancer/capture-handoff.js';
import { runCaptureWorker } from '../extensions/remembrancer/capture-worker.js';
import { captureExecution } from '../extensions/remembrancer/config.js';
import {
  getReviewerBudget,
  estimateReviewerTokens,
} from '../extensions/remembrancer/reviewer-budget.js';
import { readTaskCatalog, snapshot } from '../extensions/remembrancer/taskwarrior.js';
import { CheckpointStore } from '../extensions/remembrancer/checkpoints.js';
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

// Real worker and SDK, only Taskwarrior export is mocked. Never an external provider request.
vi.mock('../extensions/remembrancer/taskwarrior.js', async (original) => ({
  ...(await original<typeof import('../extensions/remembrancer/taskwarrior.js')>()),
  readTaskCatalog: vi.fn().mockResolvedValue([]),
}));
const successful = [
  'empty',
  'proposal',
  'large',
  'aliases',
  'dense',
  'growing',
  'renamed',
  'aggregate-object',
  'aggregate-array',
];
it.each([
  ...successful,
  'dense-truncated',
  'mixed',
  'duplicate',
  'unread',
  'missing',
  'overflow',
  'tool-error',
  'invalid-args',
  'provider-error',
])(
  'installed continuing SDK capture outcome=%s',
  async (outcome) => {
    const covered = successful.includes(outcome);
    const dir = mkdtempSync(join(tmpdir(), 'capture-sdk-'));
    const agent = join(dir, 'agent');
    mkdirSync(agent);
    vi.stubEnv('PI_CODING_AGENT_DIR', agent);
    vi.stubEnv('XDG_STATE_HOME', dir);
    const task = {
      uuid: '12345678-1234-1234-1234-123456789abc',
      status: 'pending',
      description: outcome.startsWith('aggregate-')
        ? 'Send Maya the comparison.'
        : 'Unrelated leading label '.repeat(40) + 'comparison',
      annotations:
        outcome === 'aggregate-array'
          ? Array.from({ length: 45 }, (_, i) => ({
              entry: '20260101T000000Z',
              description: `Short annotation ${i}`,
            }))
          : [{ entry: '20260101T000000Z', description: 'Retain exact snapshot '.repeat(300) }],
      ...(outcome === 'aggregate-object'
        ? Object.fromEntries(
            Array.from({ length: 130 }, (_, i) => [`custom${i}`, `short value ${i}`]),
          )
        : {}),
    };
    const matching = outcome === 'renamed' || outcome.startsWith('aggregate-');
    vi.mocked(readTaskCatalog)
      .mockReset()
      .mockResolvedValue(matching ? [task] : []);
    const sentinel = 'RESOURCE_MUST_NOT_LOAD';
    for (const root of [agent, dir]) writeFileSync(join(root, 'AGENTS.md'), sentinel);
    for (const root of [agent, join(dir, '.pi')]) {
      for (const path of ['extensions', 'skills/sentinel', 'prompts'])
        mkdirSync(join(root, path), { recursive: true });
      writeFileSync(join(root, 'extensions/forbidden.ts'), `throw new Error('${sentinel}');`);
      writeFileSync(
        join(root, 'skills/sentinel/SKILL.md'),
        `---\nname: sentinel\ndescription: ${sentinel}\n---\n${sentinel}`,
      );
      writeFileSync(join(root, 'prompts/sentinel.md'), sentinel);
      writeFileSync(join(root, 'SYSTEM.md'), sentinel);
      writeFileSync(join(root, 'APPEND_SYSTEM.md'), sentinel);
    }
    const growingParts = Array.from({ length: 35 }, (_, i) =>
      String.fromCharCode(65 + (i % 26)).repeat(120),
    );
    const records: object[] = [{ type: 'session', id: 'outgoing', cwd: dir }];
    const message = (id: string, parentId: string | null, content: string, role = 'user') => ({
      type: 'message',
      id,
      parentId,
      message: { role, content },
    });
    if (outcome === 'large') {
      records.push(message('unicode', null, '😀\\"\n'.repeat(1000)));
      let parent = 'unicode';
      for (let i = 0; i < 8; i++) {
        records.push(message(`intent${i}`, parent, `accepted:task${i}|Do task ${i}`));
        parent = `intent${i}`;
      }
      for (let i = 0; i < 6; i++) {
        records.push(message(`correction${i}`, parent, `correction:task0|Correction ${i}`));
        parent = `correction${i}`;
      }
    } else if (outcome === 'growing') {
      growingParts.forEach((part, i) =>
        records.push(
          message(
            `grow${i}`,
            i ? `grow${i - 1}` : null,
            `${i ? 'correction' : 'accepted'}:growing|${part}`,
          ),
        ),
      );
      for (const id of ['left', 'right'])
        records.push(message(id, 'grow34', `correction:growing|${id}`));
    } else if (outcome.startsWith('dense'))
      records.push(
        message(
          'dense',
          null,
          Array.from({ length: 8 }, (_, i) => `accepted:t${i}|Do${i};`).join(''),
        ),
      );
    else {
      records.push(message('promise', null, 'I will send Maya the comparison.'));
      if (outcome === 'aliases')
        for (let i = 0; i < 40; i++)
          records.push(message(`leaf${i}`, 'promise', 'Context only', 'assistant'));
    }
    const file = join(dir, 'outgoing.jsonl');
    const transcript = records.map((row) => JSON.stringify(row)).join('\n') + '\n';
    writeFileSync(file, transcript);
    const evidence: EvidencePageEntry[] = [];
    const requests: Record<string, unknown>[] = [];
    let paths = { skill: '', review: '' };
    let nextPage = 0;
    let evidenceDone = false;
    let reread = false;
    let matchingStarted = false;
    let taskJson = '';
    let taskNext: object | null = { uuid: task.uuid };
    let fixtureError: unknown;
    let submitted = 0;
    function payload(): CaptureSubmission {
      const groups = new Map<
        string,
        {
          observations: CaptureSubmission['records'][number]['observations'];
          descriptions: Map<string, string>;
        }
      >();
      function add(
        key: string,
        entry: EvidencePageEntry,
        start: number,
        end: number,
        description: string,
        kind: 'accepted' | 'correction' = 'accepted',
      ) {
        const group = groups.get(key) ?? {
          observations: [] as CaptureSubmission['records'][number]['observations'],
          descriptions: new Map<string, string>(),
        };
        group.observations.push({ kind, reference: captureReference(entry, start, end) });
        group.descriptions.set(entry.branchId, description);
        groups.set(key, group);
      }
      if (outcome !== 'empty')
        for (const entry of evidence) {
          if (entry.role !== 'user') continue;
          if (entry.entryId === 'unicode') continue;
          if (entry.entryId === 'dense') {
            for (const match of entry.text.matchAll(/accepted:t(\d)\|Do\d;/g))
              add(
                `t${match[1]}`,
                entry,
                match.index!,
                match.index! + match[0].length,
                `Do${match[1]};`,
              );
          } else if (outcome === 'large') {
            const [label, description] = entry.text.split('|');
            add(
              label!.split(':')[1]!,
              entry,
              0,
              entry.text.length,
              description!,
              label!.startsWith('correction') ? 'correction' : 'accepted',
            );
          } else if (outcome === 'growing') {
            const branch = entry.branchId;
            add(
              'growing',
              entry,
              0,
              entry.text.length,
              growingParts.join('') + branch,
              entry.entryId === 'grow0' ? 'accepted' : 'correction',
            );
          } else add('maya', entry, 0, entry.text.length, 'Send Maya the comparison.');
        }
      const result: CaptureSubmission = { records: [], dispositions: [] };
      for (const [key, group] of groups) {
        const change = matching
          ? {
              operation: 'update' as const,
              targetUuid: task.uuid,
              fields: { priority: 'H' as const },
              annotations: [],
            }
          : {
              operation: 'add' as const,
              fields: { description: group.descriptions.values().next().value! },
              annotations: [],
            };
        const question = outcome === 'growing' ? 'Left or right branch outcome?' : null;
        const states = [...group.descriptions].map(([branchId, description]) => ({
          branchId,
          state: {
            summary: key,
            status: 'active' as const,
            draft: {
              change: matching ? change : { ...change, fields: { description } },
              question,
            },
          },
        }));
        result.records.push(
          captureRecord(key, group.observations, states, {
            candidates: matching ? [{ kind: 'task', id: task.uuid, judgment: 'same' }] : [],
          }),
        );
        result.dispositions.push(
          captureDisposition(
            [key],
            { change, question, explanation: `Reviewer finalized ${key}` },
            'Accepted obligation',
          ),
        );
      }
      return result;
    }
    const server = createServer(async (request, response) => {
      try {
        request.setEncoding('utf8');
        let raw = '';
        for await (const chunk of request) raw += chunk;
        const body = JSON.parse(raw);
        requests.push(body);
        const messages = body.messages as { role: string; content: string }[];
        const text = (content: unknown) =>
          typeof content === 'string'
            ? content
            : (content as { text?: string }[]).map((part) => part.text ?? '').join('');
        paths = reviewerPaths(text(messages.find((item) => item.role === 'user')!.content));
        if (outcome === 'provider-error') {
          response.writeHead(429, { 'content-type': 'application/json' });
          response.end(
            JSON.stringify({ error: { message: 'Fixture unavailable', type: 'rate_limit_error' } }),
          );
          return;
        }
        if (outcome === 'missing') {
          writeCompletion(response, { role: 'assistant', content: 'Finished reviewing.' }, 'stop');
          return;
        }
        if (outcome === 'overflow') {
          writeCompletion(response, { role: 'assistant', content: '' }, 'length');
          return;
        }
        let calls: CaptureToolCall[];
        if (requests.length === 1)
          calls = [{ name: 'remembrancer_read', args: { path: paths.skill } }];
        else if (!evidenceDone) {
          if (nextPage) {
            const data = JSON.parse(
              text(messages.filter((item) => item.role === 'tool').at(-1)!.content),
            );
            for (const { entries, ...group } of data.groups)
              for (const entry of entries) evidence.push({ ...group, ...entry });
            evidenceDone = !data.hasMore;
          }
          if (!evidenceDone) {
            calls = [
              {
                name: 'remembrancer_read',
                args: { path: paths.review, page: outcome === 'unread' ? 1 : nextPage++ },
              },
            ];
          } else calls = [];
        } else calls = [];
        if (requests.length > 1 && evidenceDone && !calls!.length) {
          if (!reread) {
            reread = true;
            calls = [{ name: 'remembrancer_read', args: { path: paths.review, page: 0 } }];
          } else if (matching && !matchingStarted) {
            matchingStarted = true;
            calls = [{ name: 'remembrancer_tasks', args: {} }];
          } else if (matching && taskNext) {
            const data = JSON.parse(
              text(messages.filter((item) => item.role === 'tool').at(-1)!.content),
            );
            if ('json' in data) {
              taskJson += data.json;
              taskNext = data.next;
            }
            calls = taskNext ? [{ name: 'remembrancer_tasks', args: taskNext }] : [];
          }
          if (!calls!.length) {
            const args = payload();
            calls = [{ name: 'remembrancer_submit', args }];
            if (outcome === 'mixed')
              calls.push({ name: 'remembrancer_read', args: { path: paths.review } });
            if (outcome === 'duplicate') calls.push({ name: 'remembrancer_submit', args });
            if (outcome === 'tool-error')
              calls = [{ name: 'remembrancer_tasks', args: { uuid: 'missing-task' } }];
            if (outcome === 'invalid-args')
              calls = [{ name: 'remembrancer_submit', args: { wrong: args } }];
          }
        }
        submitted += calls!.filter((call) => call.name === 'remembrancer_submit').length;
        writeCompletion(
          response,
          captureToolCalls(calls!, requests.length),
          outcome === 'dense-truncated' &&
            calls!.some((call) => call.name === 'remembrancer_submit')
            ? 'length'
            : 'tool_calls',
        );
      } catch (error) {
        fixtureError = error;
        response.writeHead(500);
        response.end('Fixture assertion failed');
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const db = new CheckpointStore(join(dir, 'index.sqlite'));
    const dispose = vi.spyOn(AgentSession.prototype, 'dispose');
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Missing fixture port');
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
                  contextWindow: 1_000_000,
                  maxTokens: 64_000,
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
      expect(fixtureError).toBeUndefined();
      expect(db.captureJob('first')).toMatchObject({
        state: covered ? 'completed' : 'failed',
        attemptCount: 1,
        retryEligible: outcome === 'provider-error',
      });
      expect(db.reviewed()).toHaveLength(
        covered ? (outcome === 'aliases' ? 40 : outcome === 'growing' ? 2 : 1) : 0,
      );
      expect(db.proposals()).toHaveLength(
        outcome === 'large' || outcome === 'dense' ? 8 : covered && outcome !== 'empty' ? 1 : 0,
      );
      expect(dispose).toHaveBeenCalledOnce();
      if (covered) expect(submitted).toBe(1);
      if (outcome === 'aliases')
        expect(new Set(db.proposals()[0]!.sources.map((source) => source.branchId)).size).toBe(40);
      if (outcome === 'large') {
        expect(
          evidence
            .filter((entry) => entry.entryId === 'unicode')
            .map((entry) => entry.text)
            .join(''),
        ).toBe('😀\\"\n'.repeat(1000));
        expect(
          db
            .proposals()
            .find(
              (proposal) =>
                proposal.change.operation === 'add' &&
                proposal.change.fields.description === 'Correction 5',
            ),
        ).toBeDefined();
      }
      if (outcome === 'dense') {
        const saved = db.proposals().sort((a, b) => a.sources[0]!.offset - b.sources[0]!.offset);
        let offset = 0;
        for (const [index, proposal] of saved.entries()) {
          const quote = `accepted:t${index}|Do${index};`;
          expect(proposal.sources).toMatchObject([{ entryId: 'dense', offset, quote }]);
          expect(proposal.change).toMatchObject({ fields: { description: `Do${index};` } });
          offset += quote.length;
        }
      }
      if (outcome === 'growing') {
        expect(db.proposals()[0]!.change).toMatchObject({
          fields: { description: growingParts.join('') + 'left' },
        });
        expect(db.proposals()[0]!.question).toBeTruthy();
      }
      if (matching) {
        expect(JSON.parse(taskJson)).toEqual(task);
        expect(db.proposals()[0]!.expected).toEqual(snapshot(task));
        expect(db.proposals()[0]!.change).toMatchObject({
          operation: 'update',
          targetUuid: task.uuid,
        });
        expect(readTaskCatalog).toHaveBeenCalledOnce();
      }
      expect(requests.every((request) => request['model'] === 'fixture')).toBe(true);
      expect(
        requests.every(
          (request) => estimateReviewerTokens(request) <= getReviewerBudget(model).maxInputTokens,
        ),
      ).toBe(true);
      expect(JSON.stringify(requests)).not.toContain(sentinel);
      expect(readFileSync(file, 'utf8')).toBe(transcript);
      expect(
        (requests[0]!['tools'] as { function: { name: string } }[]).map(
          (tool) => tool.function.name,
        ),
      ).toEqual([
        'remembrancer_read',
        'remembrancer_context',
        'remembrancer_tasks',
        'remembrancer_proposals',
        'remembrancer_submit',
      ]);
      for (const [index, request] of requests.entries()) {
        const messages = request['messages'] as { role: string }[];
        expect(messages.filter((message) => message.role === 'user')).toHaveLength(1);
        expect(messages.filter((message) => message.role === 'tool')).toHaveLength(index);
      }
    } finally {
      dispose.mockRestore();
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

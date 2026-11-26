import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { CaptureReview } from '../extensions/remembrancer/capture-review.js';
import { reviewPreparedCapture } from '../extensions/remembrancer/capture.js';
import { CheckpointStore } from '../extensions/remembrancer/checkpoints.js';
import { prepareReview } from '../extensions/remembrancer/evidence.js';
import type { Proposal } from '../extensions/remembrancer/proposals.js';
import * as reviewer from '../extensions/remembrancer/reviewer.js';
import { readTaskCatalog } from '../extensions/remembrancer/taskwarrior.js';
import {
  answerCaptureReview,
  captureDisposition,
  captureRecord,
  captureReference,
} from './fixtures/capture-reviewer.js';

vi.mock('../extensions/remembrancer/taskwarrior.js', async (original) => ({
  ...(await original<typeof import('../extensions/remembrancer/taskwarrior.js')>()),
  readTaskCatalog: vi.fn(),
}));

it('uses the continuing fixture for an explicit pending revision, exact citations and declared unrelated task match', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'capture-reviewer-fixture-'));
  const db = new CheckpointStore(':memory:');
  const file = join(dir, 'session.jsonl');
  const change = {
    operation: 'add' as const,
    fields: { description: 'Send the revised comparison.' },
    annotations: [],
  };
  const saved: Proposal = {
    id: 'saved',
    revision: 3,
    state: 'pending',
    change: { ...change, fields: { description: 'Send the old comparison.' } },
    expected: null,
    question: null,
    explanation: 'Old intent',
    sources: [],
    draft: null,
    claim: null,
    result: null,
    createdAt: '',
    updatedAt: '',
  };
  const unrelated = {
    uuid: '12345678-1234-1234-1234-123456789abc',
    status: 'pending',
    description: 'Unrelated maintenance',
  };
  vi.mocked(readTaskCatalog).mockResolvedValue([unrelated]);
  vi.spyOn(db, 'proposals').mockImplementation((_state, offset = 0) => (offset ? [] : [saved]));
  vi.spyOn(db, 'proposal').mockImplementation((id) => (id === saved.id ? saved : undefined));
  // Two evidence pages, so fixture delivery cannot accidentally be a single-page shortcut.
  writeFileSync(
    file,
    [
      { type: 'session', id: 'session', cwd: dir },
      {
        type: 'message',
        id: 'entry',
        parentId: null,
        message: {
          role: 'user',
          content: 'I will send the revised comparison. ' + 'detail '.repeat(8000),
        },
      },
    ]
      .map((entry) => JSON.stringify(entry))
      .join('\n') + '\n',
  );
  const current = new CaptureReview(prepareReview([{ file, sessionId: 'session' }], []), () => {});
  const calls: string[] = [];
  const runner = vi.spyOn(reviewer, 'runReviewer').mockImplementation((input) =>
    answerCaptureReview(
      {
        ...input,
        tools: input.tools.map((tool) => ({
          ...tool,
          execute(...args) {
            calls.push(tool.name);
            return tool.execute(...args);
          },
        })),
      },
      async ({ evidence, lookup }) => {
        expect(evidence.length).toBeGreaterThan(1);
        const tasks = await lookup<{ tasks: { uuid: string }[]; nextOffset: number | null }>(
          'remembrancer_tasks',
          { query: 'maintenance' },
        );
        expect(tasks.nextOffset).toBeNull();
        const detail = await lookup<{ json: string; next: unknown }>('remembrancer_tasks', {
          uuid: tasks.tasks[0]!.uuid,
        });
        expect(detail.next).toBeNull();
        expect(JSON.parse(detail.json)).toEqual(unrelated);
        await lookup('remembrancer_proposals', {});
        const proposalDetail = await lookup<{ json: string; next: unknown }>(
          'remembrancer_proposals',
          { action: 'detail', id: saved.id, revision: saved.revision },
        );
        expect(proposalDetail.next).toBeNull();
        expect(JSON.parse(proposalDetail.json).change).toEqual(saved.change);
        const reference = captureReference(
          evidence[0]!,
          0,
          'I will send the revised comparison.'.length,
        );
        return {
          records: [
            captureRecord(
              'comparison',
              [{ kind: 'correction', reference }],
              [
                {
                  branchId: reference.branchId,
                  state: {
                    summary: 'Revised comparison',
                    status: 'active',
                    draft: { change, question: null },
                  },
                },
              ],
              {
                candidates: [
                  { kind: 'task', id: unrelated.uuid, judgment: 'different' },
                  { kind: 'proposal', id: saved.id, revision: saved.revision, judgment: 'same' },
                ],
              },
            ),
          ],
          dispositions: [
            captureDisposition(
              ['comparison'],
              { change, question: null, explanation: 'User corrected the pending obligation.' },
              'Revise the same pending comparison',
            ),
          ],
        };
      },
    ),
  );
  try {
    const result = await reviewPreparedCapture(
      current,
      db,
      {
        cwd: dir,
        sessionId: 'session',
        model: { contextWindow: 200_000, maxTokens: 4096 } as NonNullable<
          reviewer.ReviewerInput['model']
        >,
      },
      () => {},
    );
    expect(result).toEqual([
      {
        id: saved.id,
        expectedRevision: 3,
        expected: null,
        change,
        question: null,
        explanation: 'User corrected the pending obligation.',
        references: [
          {
            sessionId: 'session',
            branchId: 'entry',
            entryId: 'entry',
            editId: null,
            offset: 0,
            quote: 'I will send the revised comparison.',
          },
        ],
      },
    ]);
    expect(calls.slice(0, 3)).toEqual([
      'remembrancer_read',
      'remembrancer_read',
      'remembrancer_read',
    ]);
    expect(calls.at(-1)).toBe('remembrancer_submit');
    expect(calls.filter((name) => name === 'remembrancer_submit')).toHaveLength(1);
    expect(vi.mocked(readTaskCatalog)).toHaveBeenCalledOnce();
  } finally {
    runner.mockRestore();
    vi.restoreAllMocks();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

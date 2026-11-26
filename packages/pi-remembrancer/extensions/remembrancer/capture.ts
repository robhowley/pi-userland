import { Type } from '@sinclair/typebox';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { CaptureArtifacts } from './capture-artifacts.js';
import { captureSubmitParameters, validateCaptureSubmission } from './capture-submission.js';
import { CaptureRetryableError } from './capture-jobs.js';
import type { CheckpointStore } from './checkpoints.js';
import type { CaptureReview } from './capture-review.js';
import {
  proposalReadDescription,
  proposalReadParameters,
  readProposal,
  readProposals,
  type ProposalReadArgs,
} from './proposal-read.js';
import type { Proposal, ProposalSubmission } from './proposals.js';
import {
  fitsResponse,
  fitPrefixLength,
  safePrefixLength,
  serializedResponse,
  splitsSurrogatePair,
} from './review-pages.js';
import { buildOpeningPrompt, runReviewer, type ReviewerInput } from './reviewer.js';
import { readTaskCatalog, type TaskRecord } from './taskwarrior.js';

export const CAPTURE_BUDGET_MS = 300_000;
const cursor = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });

/** One continuing reviewer stages results. Disposal and artifact cleanup precede publication. */
export async function reviewPreparedCapture(
  current: CaptureReview,
  db: CheckpointStore,
  input: Omit<ReviewerInput, 'tools'>,
  checkDeadline: () => void,
): Promise<ProposalSubmission[]> {
  if (!input.model) throw new Error('Remembrancer reviewer requires the outgoing model');
  checkDeadline();
  const generation = db.contextGeneration();
  const artifacts = new CaptureArtifacts(current);
  let view: { tasks: TaskRecord[]; proposals: Proposal[] } | undefined;
  let staged: ProposalSubmission[] | undefined;
  let submitted = false;
  const acceptedReads = new WeakMap<object, () => void>();
  const assertFresh = () => {
    checkDeadline();
    input.signal?.throwIfAborted();
    if (db.contextGeneration() !== generation)
      throw new CaptureRetryableError('Capture review context changed; reprepare');
  };
  const guardRead = () => {
    assertFresh();
    artifacts.assertSkillDelivered();
    if (submitted) throw new Error('Capture submission is terminal');
  };
  // The first matching lookup owns one complete, typed export and proposal view.
  // All subsequent reads, including saved drafts/sources/results, use these originals.
  const matchingView = async () => {
    guardRead();
    if (!view) {
      const tasks = await readTaskCatalog(undefined, { cwd: input.cwd, signal: input.signal });
      assertFresh();
      const proposals: Proposal[] = [];
      for (let offset = 0; ; offset += 100) {
        assertFresh();
        const page = db.proposals(undefined, offset, 100);
        proposals.push(...page);
        if (page.length < 100) break;
      }
      assertFresh();
      view = structuredClone({ tasks, proposals });
    }
    return view;
  };
  const reply = (data: object) => ({
    content: [{ type: 'text' as const, text: serializedResponse(data) }],
    details: {},
  });
  const tools: ToolDefinition[] = [
    {
      name: 'remembrancer_read',
      label: 'Read capture evidence or skill',
      description: `Read only the exact installed skill path or generated review path from the opening prompt. Page is zero-based (default 0). Read the complete skill first. Evidence has ${artifacts.pageCount} pages: read the next page in order, or reread a prior page. Each result is complete text, at most 51,200 UTF-8 bytes. No other paths or directory reads are allowed. The skill's commitment, correction, deduplication, promised-outcome, ambiguity and historical-evidence guidance applies; its task mutation, approval and manual cross-session workflows do not.`,
      parameters: Type.Object(
        { path: Type.String(), page: Type.Optional(cursor) },
        { additionalProperties: false },
      ),
      executionMode: 'sequential',
      async execute(_id, args) {
        assertFresh();
        if (submitted) throw new Error('Capture submission is terminal');
        const { path, page } = args as { path: string; page?: number };
        const read = artifacts.read(path, page);
        const result = { content: [{ type: 'text' as const, text: read.text }], details: {} };
        acceptedReads.set(result, () => {
          assertFresh();
          read.accept();
        });
        return result;
      },
    },
    {
      name: 'remembrancer_context',
      label: 'Earlier frozen conversation',
      description:
        'Read earlier conversation in the owned frozen branch. Supporting context only, never eligible evidence or coverage. Select an evidence sessionId/branchId/entryId/editId from review.jsonl. Each window has at most 40 earlier entries. Finish nextOffset text continuations for that window, then use nextSkip as skip (offset 0) for the next older window, until null.',
      parameters: Type.Object(
        {
          selected: Type.Object(
            {
              sessionId: Type.String(),
              branchId: Type.String(),
              entryId: Type.String(),
              editId: Type.Union([Type.String(), Type.Null()]),
            },
            { additionalProperties: false },
          ),
          before: Type.Optional(Type.Integer({ minimum: 1, maximum: 40 })),
          skip: Type.Optional(cursor),
          offset: Type.Optional(cursor),
        },
        { additionalProperties: false },
      ),
      executionMode: 'sequential',
      async execute(_id, args) {
        guardRead();
        return reply(
          current.context({
            skip: 0,
            ...(args as Parameters<CaptureReview['context']>[0]),
            batch: current.id,
          }),
        );
      },
    },
    {
      name: 'remembrancer_tasks',
      label: 'Read retained tasks',
      description:
        'Read-only retained Taskwarrior export, including completed tasks. List with optional case-insensitive query and offset; follow nextOffset. Summaries are discovery only. For exact task detail provide uuid and optional position, concatenate json fragments until next is null. All reads use one retained attempt-local export. No task writes. Each JSON result is at most 51,200 UTF-8 bytes.',
      parameters: Type.Object(
        {
          query: Type.Optional(Type.String()),
          offset: Type.Optional(cursor),
          uuid: Type.Optional(Type.String()),
          position: Type.Optional(cursor),
        },
        { additionalProperties: false },
      ),
      executionMode: 'sequential',
      async execute(_id, args) {
        const { tasks } = await matchingView();
        const {
          query,
          offset = 0,
          uuid,
          position = 0,
        } = args as { query?: string; offset?: number; uuid?: string; position?: number };
        if (uuid !== undefined) {
          if (query !== undefined || 'offset' in (args as object))
            throw new Error('Task detail cannot use list fields');
          const task = tasks.find((item) => item['uuid'] === uuid);
          if (!task) throw new Error('Missing retained task');
          const json = JSON.stringify(task);
          if (
            !Number.isSafeInteger(position) ||
            position < 0 ||
            position > json.length ||
            splitsSurrogatePair(json, position)
          )
            throw new Error('Invalid task detail position');
          const build = (length: number) => ({
            uuid,
            position,
            json: json.slice(position, position + length),
            next: position + length < json.length ? { uuid, position: position + length } : null,
          });
          const length = fitPrefixLength(json, position, (length) => fitsResponse(build(length)));
          if (!length && position < json.length) throw new Error('Task detail cannot fit');
          return reply(build(length));
        }
        if ('position' in (args as object) || !Number.isSafeInteger(offset) || offset < 0)
          throw new Error('Invalid task list cursor');
        const term = query?.toLowerCase() ?? '';
        const matching = tasks.filter((task) =>
          ['uuid', 'description', 'project', 'waitingon'].some((key) =>
            String(task[key] ?? '')
              .toLowerCase()
              .includes(term),
          ),
        );
        const entries: object[] = [];
        for (const task of matching.slice(offset, offset + 20)) {
          const description = String(task['description'] ?? '');
          const length = safePrefixLength(description, 0, 160);
          const item = {
            uuid: task['uuid'],
            status: task['status'],
            description: description.slice(0, length),
            truncated: length < description.length,
          };
          if (!fitsResponse({ tasks: [...entries, item], nextOffset: offset + entries.length + 1 }))
            break;
          entries.push(item);
        }
        if (!entries.length && offset < matching.length) throw new Error('Task summary cannot fit');
        return reply({
          tasks: entries,
          nextOffset: offset + entries.length < matching.length ? offset + entries.length : null,
        });
      },
    },
    {
      name: 'remembrancer_proposals',
      label: 'Read retained proposals',
      description: proposalReadDescription,
      parameters: proposalReadParameters,
      executionMode: 'sequential',
      async execute(_id, args) {
        const { proposals } = await matchingView();
        const request = args as ProposalReadArgs;
        if (request.id !== undefined) readProposal(db, request.id, request.revision!);
        assertFresh();
        return reply(
          readProposals(
            {
              proposals: (state, offset = 0, limit = 50) =>
                proposals
                  .filter((proposal) => state === undefined || proposal.state === state)
                  .slice(offset, offset + limit),
              proposal: (id) => proposals.find((proposal) => proposal.id === id),
            },
            request,
          ),
        );
      },
    },
    {
      name: 'remembrancer_submit',
      label: 'Submit finalized capture',
      description:
        'Terminal submission, once and alone in its batch, only after complete skill and ordered evidence delivery. records reports commitments, not exhaustive discovery. Each record has a unique local key, exact observations (kind and eligible reference), one FoldedFinding state per observed branch, identity ambiguity (not conflicting requested changes), and declared task/proposal candidate judgments (same/different/ambiguous). Proposal candidates require retained revision; task IDs are full UUIDs. dispositions groups record keys by definite matched identity, each key exactly once, with nonempty reason and either null for verified no-change or finalized {change,question,explanation}. Preserve required questions verbatim within the final question. Never supply expected snapshots, proposal publication IDs, revisions or references in a disposition. Code binds those. Ambiguous identity needs an add-shaped question, never a guessed target. Conflicting changes to a uniquely matched task require a question while preserving that task target, never an addition. Applying/uncertain matches permit only host-verified satisfaction and null. Empty records and dispositions are valid after all delivery, meaning no commitments reported, not proven absence. Acceptance stages only in memory; cleanup and publication guards may still fail.',
      parameters: captureSubmitParameters,
      executionMode: 'sequential',
      async execute(_id, args) {
        guardRead();
        artifacts.assertDelivered();
        submitted = true;
        if (view)
          for (const proposal of view.proposals) readProposal(db, proposal.id, proposal.revision);
        staged = validateCaptureSubmission(args, current, view?.tasks ?? [], view?.proposals ?? []);
        assertFresh();
        return { ...reply({ accepted: true }), terminate: true };
      },
    },
  ];
  try {
    await runReviewer({
      ...input,
      tools,
      instruction: buildOpeningPrompt(artifacts.skillPath, artifacts.reviewPath),
      acceptToolResult(result) {
        acceptedReads.get(result)?.();
        acceptedReads.delete(result);
      },
    });
    assertFresh();
    artifacts.assertDelivered();
    if (!submitted || staged === undefined) throw new Error('Reviewer did not submit a result');
    if (view)
      for (const proposal of view.proposals) readProposal(db, proposal.id, proposal.revision);
  } finally {
    // runReviewer has already awaited disposal, including cancellation cleanup.
    artifacts.dispose();
  }
  assertFresh();
  return staged;
}

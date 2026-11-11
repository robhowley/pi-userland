import { Type, type TSchema, type Static } from '@sinclair/typebox';
import type { ExtensionContext, ToolDefinition } from '@earendil-works/pi-coding-agent';
import { CheckpointStore } from './checkpoints.js';
import { loadRemembrancerConfig } from './config.js';
import {
  beginSourceReview,
  serializedResponse,
  type AnalysisReview,
  type Selected,
} from './review.js';
import { proposalParameters, stringEnumSchema, type ProposalSubmission } from './proposals.js';
import { runReviewer } from './reviewer.js';
import { lookupTasks } from './taskwarrior.js';

export const CAPTURE_BUDGET_MS = 300_000;

/** Own one outgoing review through SDK cleanup. The extension owns the database lifetime. */
export async function captureOutgoing(
  ctx: ExtensionContext,
  store: () => CheckpointStore,
  deadline: number,
): Promise<void> {
  const file = ctx.sessionManager.getSessionFile();
  if (ctx.mode !== 'tui' || !file) return;
  let review: AnalysisReview | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const sessionId = ctx.sessionManager.getSessionId();
  try {
    const config = loadRemembrancerConfig(ctx.cwd, ctx.isProjectTrusted());
    if (config.disabled || !config.autoCapture) return;
    const controller = new AbortController();
    const checkDeadline = () => {
      if (Date.now() >= deadline) controller.abort(new Error('Review timed out'));
      controller.signal.throwIfAborted();
    };
    checkDeadline();
    timer = setTimeout(
      () => controller.abort(new Error('Review timed out')),
      deadline - Date.now(),
    );
    const db = store();
    // Preserve this source's seed default without including any other enrolled source.
    const source = db.sources().find((source) => source.sessionId === sessionId);
    review = beginSourceReview(
      db,
      [{ ...source, sessionId, file }],
      {},
      { mode: 'automatic', expires: deadline },
    );
    const current = review;
    if (current.batch.incomplete) throw new Error('Cannot capture incomplete evidence');
    if (current.batch.evidence.length === 0) return;
    let staged: ProposalSubmission[] | undefined;
    let failed = false;
    const tool = <T extends TSchema>(
      name: string,
      description: string,
      parameters: T,
      execute: (args: Static<T>) => object | Promise<object>,
      submission = false,
    ): ToolDefinition => ({
      name,
      label: name,
      description,
      parameters: parameters as unknown as ToolDefinition['parameters'],
      executionMode: 'sequential',
      async execute(_id, args) {
        try {
          checkDeadline();
          db.assertReview(current.batch.token);
          if (failed) throw new Error('Review failed');
          if (staged !== undefined) {
            if (submission) throw new Error('Duplicate submission');
            return {
              content: [{ type: 'text', text: 'Review closed.' }],
              details: {},
              terminate: true,
            };
          }
          const data = await execute(args);
          checkDeadline();
          return {
            content: [{ type: 'text', text: serializedResponse(data) }],
            details: {},
            terminate: staged !== undefined,
          };
        } catch (error) {
          failed = true;
          throw error;
        }
      },
    });
    const tools = [
      tool(
        'remembrancer_read_evidence',
        'Read the next frozen evidence page. Read every continuation before submission.',
        Type.Object({}),
        () => current.page(),
      ),
      tool(
        'remembrancer_context',
        'Read earlier frozen context for an eligible evidence item; not additional extraction scope.',
        Type.Object({
          selected: Type.Object({
            sessionId: Type.String(),
            branchId: Type.String(),
            entryId: Type.String(),
            editId: Type.Union([Type.String(), Type.Null()]),
          }),
          before: Type.Optional(Type.Integer({ minimum: 1, maximum: 40 })),
          offset: Type.Optional(Type.Integer({ minimum: 0 })),
        }),
        (args: { selected: Selected; before?: number; offset?: number }) =>
          current.context({ ...args, batch: current.batch.token }),
      ),
      tool(
        'remembrancer_tasks',
        'Read tasks, including completed tasks. No writes or arbitrary filters.',
        Type.Object({
          uuid: Type.Optional(Type.String()),
          status: Type.Optional(stringEnumSchema(['pending', 'completed'] as const)),
          offset: Type.Optional(Type.Integer({ minimum: 0 })),
        }),
        lookupTasks,
      ),
      tool(
        'remembrancer_proposals',
        'Read stored proposals, including drafts, decisions and dismissal history.',
        Type.Object({ offset: Type.Optional(Type.Integer({ minimum: 0 })) }),
        (args: { offset?: number }) => {
          const offset = args.offset ?? 0;
          const proposals = db.proposals(undefined, offset, 1);
          return { proposals, nextOffset: proposals.length ? offset + 1 : null };
        },
      ),
      tool(
        'remembrancer_submit',
        'Submit final proposals once, alone in its tool batch. Empty is valid. Does not approve or apply tasks.',
        Type.Object({ proposals: Type.Array(proposalParameters) }),
        (args: { proposals: ProposalSubmission[] }) => {
          db.validateReview(current.batch.token, args.proposals);
          staged = structuredClone(args.proposals);
          return { submitted: true };
        },
        true,
      ),
    ];
    checkDeadline();
    await runReviewer({
      cwd: ctx.cwd,
      model: ctx.model,
      sessionId,
      tools,
      signal: controller.signal,
    });
    // runReviewer has awaited prompt/abort settlement and disposed the temporary session.
    checkDeadline();
    if (failed || staged === undefined)
      throw new Error('Review did not submit a valid final result');
    current.finish(staged);
  } catch (error) {
    const detail = (error instanceof Error ? error.message : String(error))
      .split('\n')[0]!
      .slice(0, 180);
    ctx.ui.notify(`Remembrancer capture ${sessionId} failed: ${detail}`, 'warning');
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    review?.cancel();
  }
}

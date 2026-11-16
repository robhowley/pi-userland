import { Type, type TSchema, type Static } from '@sinclair/typebox';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { CheckpointStore } from './checkpoints.js';
import { serializedResponse, type Selected } from './review-pages.js';
import { proposalParameters, stringEnumSchema, type ProposalSubmission } from './proposals.js';
import { proposalReadDescription, proposalReadParameters, readProposals } from './proposal-read.js';
import { runReviewer, type ReviewerInput } from './reviewer.js';
import type { CaptureReview } from './capture-review.js';
import { lookupTasks } from './taskwarrior.js';

export const CAPTURE_BUDGET_MS = 300_000;

/** Tools stage output only. The caller owns final publication and attempt authority. */
export async function reviewPreparedCapture(
  current: CaptureReview,
  db: CheckpointStore,
  input: Omit<ReviewerInput, 'tools'>,
  checkDeadline: () => void,
  validate: (proposals: readonly ProposalSubmission[]) => void,
): Promise<ProposalSubmission[]> {
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
        if (failed) throw new Error('Review failed');
        if (staged !== undefined) {
          if (submission) throw new Error('Duplicate submission');
          return {
            content: [{ type: 'text', text: 'Review closed.' }],
            details: {},
            terminate: true,
          };
        }
        const data = await execute(args as Static<T>);
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
        current.context({ ...args, batch: current.id }),
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
      proposalReadDescription,
      proposalReadParameters,
      (args: { offset?: number }) => readProposals(db, args),
    ),
    tool(
      'remembrancer_submit',
      'Submit final proposals once, alone in its tool batch. Empty is valid. Does not approve or apply tasks.',
      Type.Object({ proposals: Type.Array(proposalParameters) }),
      (args: { proposals: ProposalSubmission[] }) => {
        validate(args.proposals);
        staged = structuredClone(args.proposals);
        return { submitted: true };
      },
      true,
    ),
  ];
  checkDeadline();
  await runReviewer({ ...input, tools });
  // runReviewer has awaited prompt/abort settlement and disposed the temporary session.
  checkDeadline();
  if (failed || staged === undefined) throw new Error('Review did not submit a valid final result');
  return staged;
}

import { Type, type Static } from '@sinclair/typebox';
import type { CheckpointStore } from './checkpoints.js';
import type { Proposal } from './proposals.js';
import { fitsResponse, REVIEW_RESPONSE_MAX_BYTES, safePrefixLength } from './review-pages.js';

export const proposalReadDescription =
  'Read stored proposals, including drafts, decisions and dismissal history. Each complete JSON response is capped at 50 KiB UTF-8. Finish all pages and continuations before reconciliation or submission. For proposalChunk, concatenate decoded text in position order and JSON-parse once nextContinuation is null. Pass nextContinuation as continuation (without offset) before advancing nextOffset as offset. If a proposal is missing or its revision changed, discard its partial text and restart at offset zero.';
export const proposalReadParameters = Type.Object({
  offset: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER - 1 })),
  continuation: Type.Optional(
    Type.Object(
      {
        id: Type.String({ minLength: 1 }),
        revision: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
        offset: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER - 1 }),
        position: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
      },
      { additionalProperties: false },
    ),
  ),
});

type ProposalReadResponse =
  | { proposals: Proposal[]; nextOffset: number | null }
  | {
      proposals: Proposal[];
      nextOffset: number;
      proposalChunk: { id: string; revision: number; position: number; text: string };
      nextContinuation: NonNullable<Static<typeof proposalReadParameters>['continuation']> | null;
    };

export function readProposals(
  db: Pick<CheckpointStore, 'proposals' | 'proposal'>,
  args: Static<typeof proposalReadParameters>,
): ProposalReadResponse {
  const continuation = args.continuation;
  if (args.offset !== undefined && continuation !== undefined)
    throw new Error('Use either proposal offset or continuation, not both.');
  const offset = continuation?.offset ?? (args.offset === undefined ? 0 : args.offset);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset >= Number.MAX_SAFE_INTEGER)
    throw new Error('Invalid proposal offset.');
  if (
    continuation !== undefined &&
    (!continuation ||
      typeof continuation.id !== 'string' ||
      !continuation.id.length ||
      !Number.isSafeInteger(continuation.revision) ||
      continuation.revision < 1 ||
      !Number.isSafeInteger(continuation.offset) ||
      !Number.isSafeInteger(continuation.position) ||
      continuation.position < 0)
  )
    throw new Error('Invalid proposal continuation.');

  const proposals = continuation
    ? [db.proposal(continuation.id)]
    : db.proposals(undefined, offset, 1);
  const proposal = proposals[0];
  if (continuation && (!proposal || proposal.revision !== continuation.revision))
    throw new Error(
      'Proposal is missing or its revision changed; discard partial text and restart at offset zero.',
    );
  const page = { proposals: proposal ? [proposal] : [], nextOffset: proposal ? offset + 1 : null };
  if (!proposal || (!continuation && fitsResponse(page))) return page;

  const text = JSON.stringify(proposal);
  const position = continuation?.position ?? 0;
  if (position >= text.length || safePrefixLength(text, 0, position) !== position)
    throw new Error('Invalid proposal continuation position; use a returned nextContinuation.');
  const chunk = (length: number) => ({
    proposals: [],
    nextOffset: offset + 1,
    proposalChunk: {
      id: proposal.id,
      revision: proposal.revision,
      position,
      text: text.slice(position, position + length),
    },
    nextContinuation:
      position + length < text.length
        ? { id: proposal.id, revision: proposal.revision, offset, position: position + length }
        : null,
  });
  const remaining = text.length - position;
  const complete = chunk(remaining);
  if (fitsResponse(complete)) return complete;

  let low = 0;
  let high = remaining - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const length = safePrefixLength(text, position, middle);
    if (fitsResponse(chunk(length))) low = middle;
    else high = middle - 1;
  }
  const length = safePrefixLength(text, position, low);
  const result = chunk(length);
  if (length === 0 || !fitsResponse(result))
    throw new Error(
      `Remembrancer response cannot fit proposal text within the ${REVIEW_RESPONSE_MAX_BYTES}-byte UTF-8 limit; metadata or envelope cannot fit.`,
    );
  return result;
}

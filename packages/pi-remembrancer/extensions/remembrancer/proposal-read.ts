import { Type, type Static } from '@sinclair/typebox';
import { CaptureRetryableError } from './capture-jobs.js';
import type { CheckpointStore } from './checkpoints.js';
import type { Proposal, ProposalSource } from './proposals.js';
import {
  fitsResponse,
  REVIEW_RESPONSE_MAX_BYTES,
  safePrefixLength,
  serializedResponse,
  splitsSurrogatePair,
} from './review-pages.js';

export const proposalReadDescription =
  'Discover stored proposals with compact list summaries (default action: list, nextOffset as offset). Summaries are not full proposals. Read action: detail with id/revision and join json fragments by position, then JSON.parse the joined text; sources are excluded. Read action: evidence with id/revision for exact saved quotes and source metadata. Follow next until null on detail/evidence. All positions are UTF-16; source offset is distinct from quotePosition. Every detail/evidence request checks revision, including the first. On missing/stale proposals discard partial reads and refresh list/current detail; automatic reviewers must abort, never retry in-review. Existing decided rows are temporary. Each complete JSON response is capped at 51,200 UTF-8 bytes.';
const cursorInteger = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
export const proposalReadParameters = Type.Object(
  {
    action: Type.Optional(Type.String({ enum: ['list', 'detail', 'evidence'] })),
    offset: Type.Optional(cursorInteger),
    id: Type.Optional(Type.String({ minLength: 1 })),
    revision: Type.Optional(Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })),
    position: Type.Optional(cursorInteger),
    index: Type.Optional(cursorInteger),
    quotePosition: Type.Optional(cursorInteger),
  },
  { additionalProperties: false },
);
export type ProposalReadArgs = Static<typeof proposalReadParameters>;
const LIST_LIMIT = 20;
const EVIDENCE_LIMIT = 100;

function integer(value: unknown, name: string, minimum = 0): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum)
    throw new Error(`Invalid proposal ${name}: expected a safe integer >= ${minimum}.`);
}

function summary(proposal: Proposal) {
  const current = proposal.draft ?? proposal;
  const description =
    current.change.operation === 'complete'
      ? (current.expected?.fields.description ?? '')
      : (current.change.fields.description ?? current.expected?.fields.description ?? '');
  const length = safePrefixLength(description, 0, 160);
  return {
    id: proposal.id,
    revision: proposal.revision,
    state: proposal.state,
    operation: current.change.operation,
    targetUuid: current.change.operation === 'add' ? null : current.change.targetUuid,
    label: description.slice(0, length),
    labelTruncated: length < description.length,
    hasDraft: proposal.draft !== null,
    hasQuestion: proposal.question !== null || current.question !== null,
    evidenceCount: proposal.sources.length,
  };
}

function list(db: CheckpointStore, offset: number) {
  integer(offset, 'offset');
  const candidates = db.proposals(undefined, offset, LIST_LIMIT + 1);
  const proposals: ReturnType<typeof summary>[] = [];
  for (const proposal of candidates.slice(0, LIST_LIMIT)) {
    const nextOffset = offset + proposals.length + 1;
    integer(nextOffset, 'next offset');
    const item = summary(proposal);
    const page = {
      action: 'list',
      proposals: [...proposals, item],
      nextOffset: candidates.length > proposals.length + 1 ? nextOffset : null,
    };
    if (!fitsResponse(page)) {
      if (!proposals.length) throw new Error('Proposal summary metadata or envelope cannot fit.');
      break;
    }
    proposals.push(item);
  }
  const data = {
    action: 'list' as const,
    proposals,
    nextOffset: candidates.length > proposals.length ? offset + proposals.length : null,
  };
  serializedResponse(data);
  return data;
}

function position(text: string, value: number, name: string): void {
  integer(value, name);
  if (value > text.length) throw new Error(`Invalid proposal ${name}: beyond the text.`);
  if (splitsSurrogatePair(text, value))
    throw new Error(
      `Invalid proposal ${name}: splits a surrogate pair; use the returned next cursor.`,
    );
}

// Size the complete encoded envelope, not just the unescaped fragment.
function fragmentLength(text: string, start: number, fits: (length: number) => boolean): number {
  let low = 0;
  let high = Math.min(text.length - start, REVIEW_RESPONSE_MAX_BYTES);
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (fits(safePrefixLength(text, start, middle))) low = middle;
    else high = middle - 1;
  }
  return safePrefixLength(text, start, low);
}

type EvidenceFragment = ProposalSource & {
  index: number;
  quotePosition: number;
  continues: boolean;
};

export function readProposals(db: CheckpointStore, args: ProposalReadArgs) {
  const action = args.action ?? 'list';
  const allowed =
    action === 'list'
      ? ['action', 'offset']
      : action === 'detail'
        ? ['action', 'id', 'revision', 'position']
        : action === 'evidence'
          ? ['action', 'id', 'revision', 'index', 'quotePosition']
          : [];
  if (!allowed.length || Object.keys(args).some((key) => !allowed.includes(key)))
    throw new Error('Invalid proposal read action or cursor fields.');
  if (action === 'list') return list(db, args.offset ?? 0);
  if (typeof args.id !== 'string' || !args.id.trim()) throw new Error('Invalid proposal ID.');
  integer(args.revision, 'revision', 1);
  const proposal = db.proposal(args.id);
  if (!proposal)
    throw new CaptureRetryableError(
      'Missing proposal; discard partial reads and refresh the list.',
    );
  if (proposal.revision !== args.revision)
    throw new CaptureRetryableError(
      'Stale proposal; discard partial reads and refresh the list/current detail.',
    );
  const identity = { id: proposal.id, revision: proposal.revision };
  if (action === 'detail') {
    const text = JSON.stringify(
      Object.fromEntries(Object.entries(proposal).filter(([key]) => key !== 'sources')),
    );
    const start = args.position ?? 0;
    position(text, start, 'position');
    const build = (length: number) => ({
      action: 'detail' as const,
      ...identity,
      position: start,
      json: text.slice(start, start + length),
      next:
        start + length < text.length
          ? { action: 'detail' as const, ...identity, position: start + length }
          : null,
    });
    const length = fragmentLength(text, start, (length) => fitsResponse(build(length)));
    if (length === 0 && start < text.length)
      throw new Error('Proposal detail metadata or envelope cannot fit with positive progress.');
    const data = build(length);
    serializedResponse(data);
    return data;
  }

  let index = args.index ?? 0;
  let quotePosition = args.quotePosition ?? 0;
  integer(index, 'evidence index');
  integer(quotePosition, 'quotePosition');
  if (index > proposal.sources.length || (index === proposal.sources.length && quotePosition !== 0))
    throw new Error('Invalid proposal evidence cursor: beyond the sources.');
  const entries: EvidenceFragment[] = [];
  const build = (items: EvidenceFragment[], nextIndex: number, nextPosition: number) => ({
    action: 'evidence' as const,
    ...identity,
    entries: items,
    next:
      nextIndex < proposal.sources.length
        ? {
            action: 'evidence' as const,
            ...identity,
            index: nextIndex,
            quotePosition: nextPosition,
          }
        : null,
  });
  while (index < proposal.sources.length && entries.length < EVIDENCE_LIMIT) {
    const source = proposal.sources[index]!;
    position(source.quote, quotePosition, 'quotePosition');
    if (quotePosition === source.quote.length && quotePosition !== 0)
      throw new Error('Invalid proposal quotePosition: completed quotes must advance the index.');
    const candidate = (length: number) => {
      const end = quotePosition + length;
      const continues = end < source.quote.length;
      const entry = {
        ...source,
        index,
        quotePosition,
        quote: source.quote.slice(quotePosition, end),
        continues,
      };
      return { entry, nextIndex: continues ? index : index + 1, nextPosition: continues ? end : 0 };
    };
    const length = fragmentLength(source.quote, quotePosition, (length) => {
      const { entry, nextIndex, nextPosition } = candidate(length);
      return fitsResponse(build([...entries, entry], nextIndex, nextPosition));
    });
    const { entry, nextIndex, nextPosition } = candidate(length);
    if (
      (length === 0 && source.quote.length > 0) ||
      !fitsResponse(build([...entries, entry], nextIndex, nextPosition))
    ) {
      if (!entries.length)
        throw new Error(
          'Proposal evidence metadata or envelope cannot fit with positive progress.',
        );
      break;
    }
    entries.push(entry);
    index = nextIndex;
    quotePosition = nextPosition;
    if (entry.continues) break;
  }
  const data = build(entries, index, quotePosition);
  serializedResponse(data);
  return data;
}

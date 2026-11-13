import { Type } from '@earendil-works/pi-ai';
import type { CheckpointStore } from './checkpoints.js';

export const proposalReadDescription =
  'Read stored proposals, including drafts, decisions and dismissal history. Each complete JSON response is capped at 50 KiB UTF-8.';
export const proposalReadParameters = Type.Object({
  offset: Type.Optional(Type.Integer({ minimum: 0 })),
});

export function readProposals(db: CheckpointStore, { offset = 0 }: { offset?: number }) {
  const proposals = db.proposals(undefined, offset, 1);
  return { proposals, nextOffset: proposals.length ? offset + 1 : null };
}

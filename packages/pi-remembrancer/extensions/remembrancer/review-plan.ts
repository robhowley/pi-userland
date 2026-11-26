import { resolve } from 'node:path';
import type { PreparedReview } from './evidence.js';

const ownedReviews = new WeakSet<PreparedReview>();
/** Share one private frozen input between delivery and publication, never caller-owned state. */
export function ownReview(review: PreparedReview): PreparedReview {
  if (ownedReviews.has(review)) return review;
  const sources = [
    ...review.successfulSources,
    ...review.snapshots.map((snapshot) => snapshot.source),
    ...review.evidence,
    ...review.tips,
    ...review.checkpoints,
  ];
  const first = sources[0];
  if (
    sources.some(
      (source) =>
        source.sessionId !== first?.sessionId || resolve(source.file) !== resolve(first.file),
    ) ||
    review.sourceDefaults.some((source) => source.sessionId !== first?.sessionId)
  )
    throw new Error('A capture review plan requires one frozen session source.');
  const copy = structuredClone(review);
  ownedReviews.add(copy);
  return copy;
}

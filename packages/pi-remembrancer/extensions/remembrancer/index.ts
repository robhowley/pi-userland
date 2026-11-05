import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { StringEnum, Type } from '@earendil-works/pi-ai';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { CheckpointStore } from './checkpoints.js';
import { loadRemembrancerConfig } from './config.js';
import { discoverSources } from './discovery.js';
import {
  branchEvidence,
  prepareReview,
  resolveSeedSince,
  type Checkpoint,
  type Evidence,
  type SeedDefault,
  type SessionSnapshot,
  type Source,
  type Tip,
} from './evidence.js';

type Selected = {
  sessionId: string;
  branchId: string;
  entryId: string;
  editId: string | null;
};

type ReviewArgs = {
  action: 'begin' | 'next' | 'finish' | 'cancel' | 'context';
  batch?: string;
  seed?: string;
  selected?: Selected;
  before?: number;
  offset?: number;
};

type Batch = {
  token: string;
  tips: Tip[];
  checkpoints: Checkpoint[];
  sourceDefaults: SeedDefault[];
  stagedSources: Source[];
  snapshots: SessionSnapshot[];
  evidence: Evidence[];
  warnings: string[];
  incomplete: boolean;
  coverageChanged: boolean;
  requestedSince: string | null;
  index: number;
  offset: number;
};

const selectedParameters = Type.Object({
  sessionId: Type.String(),
  branchId: Type.String(),
  entryId: Type.String(),
  editId: Type.Union([Type.String(), Type.Null()]),
});

// Return every character, even when one message is larger than an entire page.
function page(batch: Batch) {
  const entries = [];
  let remaining = 12000;
  while (remaining > 0 && entries.length < 40 && batch.index < batch.evidence.length) {
    const evidence = batch.evidence[batch.index];
    if (!evidence) break;
    const { text, ...source } = evidence;
    const start = batch.offset;
    const excerpt = text.slice(start, start + remaining);
    remaining -= excerpt.length;
    batch.offset += excerpt.length;
    const continues = batch.offset < text.length;
    entries.push({ ...source, text: excerpt, offset: start, continues });
    if (!continues) {
      batch.index++;
      batch.offset = 0;
    }
  }
  return { batch: batch.token, entries, hasMore: batch.index < batch.evidence.length };
}

function sourceKey(source: Pick<Source, 'sessionId' | 'file'>): string {
  return `${source.sessionId}\u0000${resolve(source.file)}`;
}

function usesDefaultSessionDir(ctx: ExtensionContext): boolean {
  const manager = ctx.sessionManager as ExtensionContext['sessionManager'] & {
    usesDefaultSessionDir?: () => boolean;
  };
  return manager.usesDefaultSessionDir?.() === true;
}

function contextPage(items: Evidence[], offset: number) {
  const total = items.reduce((length, item) => length + item.text.length, 0);
  if (offset > total) throw new Error('Context offset is beyond the requested range');

  const entries = [];
  let position = 0;
  let remaining = 12000;
  let written = 0;
  for (const item of items) {
    const end = position + item.text.length;
    if (offset >= end) {
      position = end;
      continue;
    }
    const localOffset = Math.max(0, offset - position);
    const text = item.text.slice(localOffset, localOffset + remaining);
    if (text.length === 0) break;
    entries.push({
      ...item,
      text,
      offset: localOffset,
      continues: localOffset + text.length < item.text.length,
    });
    written += text.length;
    remaining -= text.length;
    position = end;
    if (remaining === 0) break;
  }

  const nextOffset = offset + written < total ? offset + written : null;
  return { entries, nextOffset };
}

export default function remembrancer(pi: ExtensionAPI) {
  let db: CheckpointStore | undefined;
  let batch: Batch | undefined;
  const store = () => (db ??= new CheckpointStore());

  function enroll(ctx: ExtensionContext) {
    const sm = ctx.sessionManager;
    const file = sm.getSessionFile();
    if (!file) return;
    const source = { file: resolve(file), sessionId: sm.getSessionId() };
    store().enroll(source.sessionId, source.file);
  }

  function release() {
    batch = undefined;
    db?.releaseReview();
  }

  function result(data: object) {
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(data) }],
      details: {},
    };
  }

  function beginReview(args: ReviewArgs, ctx: ExtensionContext, requestedSince: string | null) {
    if (args.seed === undefined) enroll(ctx);

    const enrolled = store().sources();
    const discovery =
      requestedSince === null
        ? undefined
        : discoverSources(
            ctx.sessionManager.getSessionDir(),
            enrolled,
            requestedSince,
            usesDefaultSessionDir(ctx),
          );
    const sources = discovery?.sources ?? enrolled;
    const review = prepareReview(
      sources,
      store().reviewed(),
      { requestedSince },
      discovery?.snapshots,
    );
    const successful = new Set(review.successfulSources.map(sourceKey));
    const stagedSources = (discovery?.newSources ?? []).filter((source) =>
      successful.has(sourceKey(source)),
    );
    const warnings = [...(discovery?.warnings ?? []), ...review.warnings];
    const incomplete = Boolean(discovery?.incomplete || review.incomplete);
    const coverageChanged = review.coverageChanged || stagedSources.length > 0;

    batch = {
      token: randomUUID(),
      tips: review.tips,
      checkpoints: review.checkpoints,
      sourceDefaults: review.sourceDefaults,
      stagedSources,
      snapshots: review.snapshots,
      evidence: review.evidence,
      warnings,
      incomplete,
      coverageChanged,
      requestedSince,
      index: 0,
      offset: 0,
    };

    const status = incomplete
      ? 'incomplete'
      : review.evidence.length > 0
        ? 'review'
        : coverageChanged
          ? 'coverage-pending'
          : 'already-covered';
    return {
      ...page(batch),
      status,
      warnings,
      incomplete,
      coverageChanged,
      ...(requestedSince === null ? {} : { requestedSince }),
      capturedTips: batch.tips.length,
    };
  }

  function contextReview(args: ReviewArgs): object {
    if (!batch || args.batch !== batch.token)
      throw new Error('No matching open review in this Pi session.');
    const selected = args.selected;
    if (!selected) throw new Error('Context requires a selected evidence item.');
    const selectedEvidence = batch.evidence.find(
      (item) =>
        item.sessionId === selected.sessionId &&
        item.branchId === selected.branchId &&
        item.entryId === selected.entryId &&
        item.editId === selected.editId,
    );
    if (!selectedEvidence) throw new Error('Selected evidence is not in this review batch.');

    const snapshot = batch.snapshots.find(
      (candidate) =>
        candidate.source.sessionId === selected.sessionId &&
        resolve(candidate.source.file) === resolve(selectedEvidence.file),
    );
    if (!snapshot) throw new Error('Selected evidence snapshot is unavailable.');

    const branch = branchEvidence(
      snapshot.tree,
      {
        file: snapshot.source.file,
        sessionId: selected.sessionId,
        entryId: selected.branchId,
      },
      selectedEvidence.reviewedThrough,
    );
    const selectedIndex = branch.findIndex(
      (item) => item.entryId === selected.entryId && item.editId === selected.editId,
    );
    if (selectedIndex < 0) throw new Error('Selected evidence is not in the frozen branch.');

    const before = args.before ?? 1;
    const offset = args.offset ?? 0;
    if (!Number.isInteger(before) || before < 1 || before > 40)
      throw new Error('Context before must be an integer from 1 to 40.');
    if (!Number.isInteger(offset) || offset < 0)
      throw new Error('Context offset must be a nonnegative integer.');

    const items = branch.slice(Math.max(0, selectedIndex - before), selectedIndex);
    const paged = contextPage(items, offset);
    return {
      batch: batch.token,
      selected,
      contextOnly: true,
      entries: paged.entries,
      nextOffset: paged.nextOffset,
    };
  }

  pi.on('session_start', (_event, ctx) => {
    if (loadRemembrancerConfig(ctx.cwd, ctx.isProjectTrusted()).disabled) return;
    registerReviewTool();
    enroll(ctx);
  });
  pi.on('session_shutdown', () => {
    batch = undefined;
    db?.close();
    db = undefined;
  });

  function registerReviewTool() {
    pi.registerTool({
      name: 'remembrancer_review',
      label: 'Remembrancer review',
      description:
        'Read incremental cross-session evidence or finish a fully resolved review. Follow the remembrancer skill. Read every page before finishing.',
      parameters: Type.Object({
        action: StringEnum(['begin', 'next', 'context', 'finish', 'cancel'] as const),
        batch: Type.Optional(
          Type.String({
            description: 'Token from begin. Required for next, context, finish, or cancel.',
          }),
        ),
        seed: Type.Optional(
          Type.String({ description: 'Seed duration such as 14d. Valid only with action begin.' }),
        ),
        selected: Type.Optional(selectedParameters),
        before: Type.Optional(Type.Integer({ minimum: 1, maximum: 40 })),
        offset: Type.Optional(Type.Integer({ minimum: 0 })),
      }),
      async execute(_id, args: ReviewArgs, _signal, _update, ctx) {
        if (!ctx.sessionManager.getSessionFile())
          throw new Error('Full review requires a saved Pi session.');

        const hasContextArguments =
          args.selected !== undefined || args.before !== undefined || args.offset !== undefined;
        if (args.action !== 'context' && hasContextArguments)
          throw new Error('Context arguments require action context.');
        if (args.action !== 'begin' && args.seed !== undefined)
          throw new Error('Seed is valid only with action begin.');
        if (args.action === 'begin' && args.batch !== undefined)
          throw new Error('Begin does not accept a batch token.');

        if (args.action === 'begin') {
          if (batch)
            throw new Error('Review already open. Continue or cancel batch ' + batch.token);
          // Resolve the seed before claiming the lock. A rejected request must
          // not leave an interactive review open, and later pages must reuse the
          // same absolute instant.
          const requestedSince = args.seed === undefined ? null : resolveSeedSince(args.seed);
          store().claimReview();
          try {
            return result(beginReview(args, ctx, requestedSince));
          } catch (error) {
            release();
            throw error;
          }
        }

        if (!batch || args.batch !== batch.token)
          throw new Error('No matching open review in this Pi session.');
        if (args.action === 'next') return result(page(batch));
        if (args.action === 'context') return result(contextReview(args));
        if (args.action === 'cancel') {
          release();
          return result({ cancelled: true });
        }
        if (args.action !== 'finish') throw new Error('Unknown remembrancer_review action');
        if (batch.index < batch.evidence.length)
          throw new Error('Read all evidence pages before finishing.');

        store().finish({
          sources: batch.stagedSources,
          sourceDefaults: batch.sourceDefaults,
          checkpoints: batch.checkpoints,
        });
        const reviewedTips = batch.tips.length;
        const finishedBatch = batch;
        release();
        const response: Record<string, unknown> = { finished: true, reviewedTips };
        if (finishedBatch.requestedSince !== null || finishedBatch.incomplete) {
          response['coverageChanged'] = finishedBatch.coverageChanged;
          response['incomplete'] = finishedBatch.incomplete;
          response['warnings'] = finishedBatch.warnings;
          response['status'] = finishedBatch.incomplete
            ? 'partial'
            : finishedBatch.coverageChanged
              ? 'coverage-finished'
              : 'already-covered';
          if (finishedBatch.requestedSince !== null)
            response['requestedSince'] = finishedBatch.requestedSince;
        }
        return result(response);
      },
    });
  }
}

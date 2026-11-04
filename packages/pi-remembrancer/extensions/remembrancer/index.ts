import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { StringEnum, Type } from '@earendil-works/pi-ai';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { CheckpointStore } from './checkpoints.js';
import { loadRemembrancerConfig } from './config.js';
import { prepareReview, type Evidence, type Tip } from './evidence.js';

type Batch = {
  token: string;
  tips: Tip[];
  evidence: Evidence[];
  index: number;
  offset: number;
};

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
        action: StringEnum(['begin', 'next', 'finish', 'cancel'] as const),
        batch: Type.Optional(
          Type.String({ description: 'Token from begin. Required for next, finish, or cancel.' }),
        ),
      }),
      async execute(_id, args, _signal, _update, ctx) {
        const result = (data: object) => ({
          content: [{ type: 'text' as const, text: JSON.stringify(data) }],
          details: {},
        });
        if (!ctx.sessionManager.getSessionFile())
          throw new Error('Full review requires a saved Pi session.');
        if (args.action === 'begin') {
          if (batch)
            throw new Error('Review already open. Continue or cancel batch ' + batch.token);
          store().claimReview();
          try {
            enroll(ctx);
            const review = prepareReview(store().sources(), store().reviewed());
            batch = {
              token: randomUUID(),
              tips: review.tips,
              evidence: review.evidence,
              index: 0,
              offset: 0,
            };
            return result({
              ...page(batch),
              warnings: review.warnings,
              capturedTips: batch.tips.length,
            });
          } catch (error) {
            release();
            throw error;
          }
        }
        if (!batch || args.batch !== batch.token)
          throw new Error('No matching open review in this Pi session.');
        if (args.action === 'next') return result(page(batch));
        if (args.action === 'cancel') {
          release();
          return result({ cancelled: true });
        }
        if (args.action !== 'finish') throw new Error('Unknown remembrancer_review action');
        if (batch.index < batch.evidence.length)
          throw new Error('Read all evidence pages before finishing.');
        // Only the frozen boundaries advance. A later append remains eligible.
        store().finish(batch.tips);
        const reviewedTips = batch.tips.length;
        release();
        return result({ finished: true, reviewedTips });
      },
    });
  }
}

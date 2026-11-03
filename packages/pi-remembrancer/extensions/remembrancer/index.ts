import { randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import { StringEnum, Type } from '@earendil-works/pi-ai';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { CheckpointStore } from './checkpoints.js';
import { prepareReview, recover, type Evidence, type Tip } from './capture.js';

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
  if (
    process.env['PI_REMEMBRANCER_DISABLED'] === '1' ||
    Number(process.env['PI_SUBAGENT_DEPTH']) > 0
  )
    return;
  let db: CheckpointStore | undefined;
  let batch: Batch | undefined;
  const store = () => (db ??= new CheckpointStore());

  function snapshot(ctx: ExtensionContext, recordTip: boolean) {
    const sm = ctx.sessionManager;
    const file = sm.getSessionFile();
    if (!file) return;
    const source = { file: resolve(file), sessionId: sm.getSessionId() };
    store().enroll(source.sessionId, source.file);
    const entryId = sm.getLeafId();
    if (recordTip && entryId) store().capture({ ...source, entryId });
  }

  // Recover only sessions that ran the extension, including custom session dirs.
  // Save the pre-read signature so any concurrent append is discovered next time.
  function recoverChanged() {
    const warnings: string[] = [];
    for (const source of store().sources()) {
      try {
        const stat = statSync(source.file);
        const signature = stat.size + ':' + stat.mtimeMs;
        if (source.signature === signature || !stat.size) continue;
        const read = recover([source]);
        warnings.push(...read.warnings);
        if (!read.trees.size) continue;
        for (const tip of read.tips) store().capture(tip);
        store().noteScan(source.sessionId, signature, source.file);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
          warnings.push(source.file + ': ' + String(error));
      }
    }
    return warnings;
  }

  function release() {
    batch = undefined;
    db?.releaseReview();
  }

  pi.on('session_start', (_event, ctx) => {
    if (!ctx.sessionManager.getSessionFile()) return;
    snapshot(ctx, false);
    const warnings = recoverChanged();
    if (warnings.length && ctx.hasUI) ctx.ui.notify('Remembrancer: ' + warnings[0], 'warning');
  });
  pi.on('session_compact', (_event, ctx) => snapshot(ctx, true));
  pi.on('session_shutdown', (_event, ctx) => {
    try {
      snapshot(ctx, true);
    } finally {
      batch = undefined;
      db?.close();
      db = undefined;
    }
  });

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
        if (batch) throw new Error('Review already open. Continue or cancel batch ' + batch.token);
        store().claimReview();
        try {
          snapshot(ctx, true);
          const warnings = recoverChanged();
          const review = prepareReview(store().pending(), store().reviewed());
          warnings.push(...review.warnings);
          batch = {
            token: randomUUID(),
            tips: review.tips,
            evidence: review.evidence,
            index: 0,
            offset: 0,
          };
          return result({
            ...page(batch),
            warnings: [...new Set(warnings)],
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
      // Only the exact captured tips advance. A later append remains eligible.
      store().finish(batch.tips);
      const reviewedTips = batch.tips.length;
      release();
      return result({ finished: true, reviewedTips });
    },
  });
}

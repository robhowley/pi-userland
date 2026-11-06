import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { StringEnum, Type } from '@earendil-works/pi-ai';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { CheckpointStore } from './checkpoints.js';
import { loadRemembrancerConfig } from './config.js';
import { discoverSources } from './discovery.js';
import {
  renderReviewCall,
  renderReviewResult,
  type ReviewResultDetails,
  type ReviewAction,
} from './render.js';
import { copyWarnings, warningMessages, type WarningRecord } from './warnings.js';
import {
  branchEvidence,
  prepareReview,
  resolveSeedSince,
  ReviewBudget,
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
  warnings: WarningRecord[];
  incomplete: boolean;
  coverageChanged: boolean;
  seed?: string;
  requestedSince: string | null;
  index: number;
  offset: number;
};

export const REMEMBRANCER_COMMAND_NAME = 'remembrancer';
export const REMEMBRANCER_COMMAND_USAGE =
  'Usage: /remembrancer seed <Nd>\n       /remembrancer help';
export const REMEMBRANCER_HELP = [
  REMEMBRANCER_COMMAND_USAGE,
  'Seed saved-session evidence from a bounded historical window, then follow the Remembrancer skill.',
  'Natural-language review requests remain supported.',
].join('\n');

const REMEMBRANCER_SUBCOMMANDS = [
  {
    value: 'seed ',
    label: 'seed',
    description: 'Review saved-session evidence from a bounded historical window',
  },
  { value: 'help', label: 'help', description: 'Show Remembrancer command usage' },
];
const REMEMBRANCER_SEED_DURATIONS = [
  { value: '1d', label: '1d', description: 'Last day' },
  { value: '7d', label: '7d', description: 'Last 7 days' },
  { value: '14d', label: '14d', description: 'Last 14 days' },
  { value: '30d', label: '30d', description: 'Last 30 days' },
  { value: '90d', label: '90d', description: 'Last 90 days' },
];

type RemembrancerCommandArgs =
  | { ok: true; mode: 'help' }
  | { ok: true; mode: 'seed'; duration: string }
  | { ok: false; message: string };

export function parseRemembrancerCommandArgs(args: string): RemembrancerCommandArgs {
  const tokens = args.trim().length === 0 ? [] : args.trim().split(/\s+/u);
  const subcommand = tokens[0];

  if (tokens.length === 0 || (subcommand === 'help' && tokens.length === 1))
    return { ok: true, mode: 'help' };
  if (subcommand === 'help')
    return { ok: false, message: `Help does not accept arguments. ${REMEMBRANCER_COMMAND_USAGE}` };
  if (subcommand !== 'seed')
    return {
      ok: false,
      message: `Unknown subcommand: ${subcommand}. ${REMEMBRANCER_COMMAND_USAGE}`,
    };
  if (tokens.length !== 2)
    return {
      ok: false,
      message: `Seed requires exactly one duration such as 14d. ${REMEMBRANCER_COMMAND_USAGE}`,
    };

  const duration = tokens[1]!;
  try {
    resolveSeedSince(duration);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      message: `Invalid seed duration "${duration}": ${detail}. ${REMEMBRANCER_COMMAND_USAGE}`,
    };
  }
  return { ok: true, mode: 'seed', duration };
}

export function getRemembrancerArgumentCompletions(prefix: string) {
  const input = prefix.trimStart();
  const trailingWhitespace = /\s$/u.test(input);
  const tokens = input.trim().length === 0 ? [] : input.trim().split(/\s+/u);

  if (tokens.length === 0) return REMEMBRANCER_SUBCOMMANDS;
  if (tokens.length === 1) {
    const token = tokens[0]!;
    if (trailingWhitespace) {
      return token === 'seed'
        ? REMEMBRANCER_SEED_DURATIONS.map((item) => ({ ...item, value: `seed ${item.value}` }))
        : null;
    }
    const matches = REMEMBRANCER_SUBCOMMANDS.filter((item) => item.value.startsWith(token));
    return matches.length > 0 ? matches : null;
  }
  if (tokens[0] !== 'seed' || tokens.length !== 2 || trailingWhitespace) return null;

  const token = tokens[1]!;
  const matches = REMEMBRANCER_SEED_DURATIONS.filter((item) => item.value.startsWith(token));
  return matches.length > 0
    ? matches.map((item) => ({ ...item, value: `seed ${item.value}` }))
    : null;
}

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
  if (typeof manager.usesDefaultSessionDir !== 'function')
    throw new Error(
      'Upgrade Pi to use Remembrancer seed: this version cannot identify session archive storage.',
    );
  return manager.usesDefaultSessionDir();
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

  function currentSource(ctx: ExtensionContext): Source | undefined {
    const sm = ctx.sessionManager;
    const file = sm.getSessionFile();
    return file ? { file: resolve(file), sessionId: sm.getSessionId() } : undefined;
  }

  function enroll(ctx: ExtensionContext) {
    const source = currentSource(ctx);
    if (source) store().enroll(source.sessionId, source.file);
  }

  function release() {
    batch = undefined;
    db?.releaseReview();
  }

  function result(data: object, details: ReviewResultDetails) {
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(data) }],
      details,
    };
  }

  function resultDetails(action: ReviewAction, current: Batch): ReviewResultDetails {
    return {
      action,
      batch: current.token,
      ...(current.seed === undefined ? {} : { seed: current.seed }),
      ...(current.requestedSince === null ? {} : { requestedSince: current.requestedSince }),
      incomplete: current.incomplete,
      warnings: copyWarnings(current.warnings),
      coverageChanged: current.coverageChanged,
    };
  }

  pi.registerCommand(REMEMBRANCER_COMMAND_NAME, {
    description: 'Start a bounded historical Remembrancer review',
    getArgumentCompletions: getRemembrancerArgumentCompletions,
    handler: async (args, ctx) => {
      const parsed = parseRemembrancerCommandArgs(args);
      if (!parsed.ok) {
        ctx.ui.notify(parsed.message, 'error');
        return;
      }
      if (parsed.mode === 'help') {
        ctx.ui.notify(REMEMBRANCER_HELP, 'info');
        return;
      }
      if (loadRemembrancerConfig(ctx.cwd, ctx.isProjectTrusted()).disabled) {
        ctx.ui.notify(
          'Remembrancer is disabled in settings. Set pi-remembrancer.disabled to false to enable it.',
          'warning',
        );
        return;
      }
      if (!ctx.isIdle()) {
        ctx.ui.notify(
          'Pi is busy. Wait for the current run to finish, then retry the seed command.',
          'warning',
        );
        return;
      }
      if (batch) {
        ctx.ui.notify(
          'A Remembrancer review is already open in this Pi session. Finish or cancel it before starting another seed.',
          'warning',
        );
        return;
      }

      pi.sendUserMessage(`/skill:remembrancer seed ${parsed.duration}`, {
        expandPromptTemplates: true,
      });
    },
  });

  function beginReview(args: ReviewArgs, ctx: ExtensionContext, requestedSince: string | null) {
    const current = args.seed === undefined ? currentSource(ctx) : undefined;
    const budget = new ReviewBudget();
    const enrolled = store().sources();
    const reviewSources = current
      ? enrolled.some((source) => source.sessionId === current.sessionId)
        ? enrolled.map((source) =>
            source.sessionId === current.sessionId ? { ...source, file: current.file } : source,
          )
        : [...enrolled, current]
      : enrolled;
    const discovery =
      requestedSince === null
        ? undefined
        : discoverSources(
            ctx.sessionManager.getSessionDir(),
            enrolled,
            requestedSince,
            usesDefaultSessionDir(ctx),
            budget,
          );
    const sources = discovery?.sources ?? reviewSources;
    const review = prepareReview(
      sources,
      store().reviewed(),
      { requestedSince },
      discovery?.snapshots,
      budget,
    );
    const successful = new Set(review.successfulSources.map(sourceKey));
    if (current && successful.has(sourceKey(current)))
      store().enroll(current.sessionId, current.file);
    const stagedSources = (discovery?.newSources ?? []).filter((source) =>
      successful.has(sourceKey(source)),
    );
    const warningRecords = [...(discovery?.warnings ?? []), ...review.warnings];
    const warnings = warningMessages(warningRecords);
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
      warnings: warningRecords,
      incomplete,
      coverageChanged,
      ...(args.seed === undefined ? {} : { seed: args.seed }),
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
      renderCall: renderReviewCall,
      renderResult: renderReviewResult,
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
            const response = beginReview(args, ctx, requestedSince);
            return result(response, resultDetails('begin', batch!));
          } catch (error) {
            release();
            throw error;
          }
        }

        if (!batch || args.batch !== batch.token)
          throw new Error('No matching open review in this Pi session.');
        if (args.action === 'next') return result(page(batch), resultDetails('next', batch));
        if (args.action === 'context') {
          const response = contextReview(args);
          return result(response, resultDetails('context', batch));
        }
        if (args.action === 'cancel') {
          const details = resultDetails('cancel', batch);
          release();
          return result({ cancelled: true }, details);
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
        const details = resultDetails('finish', finishedBatch);
        release();
        const response: Record<string, unknown> = { finished: true, reviewedTips };
        if (finishedBatch.requestedSince !== null || finishedBatch.incomplete) {
          response['coverageChanged'] = finishedBatch.coverageChanged;
          response['incomplete'] = finishedBatch.incomplete;
          response['warnings'] = warningMessages(finishedBatch.warnings);
          response['status'] = finishedBatch.incomplete
            ? 'partial'
            : finishedBatch.coverageChanged
              ? 'coverage-finished'
              : 'already-covered';
          if (finishedBatch.requestedSince !== null)
            response['requestedSince'] = finishedBatch.requestedSince;
        }
        return result(response, details);
      },
    });
  }
}

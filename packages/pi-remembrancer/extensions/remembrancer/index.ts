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

export const REVIEW_RESPONSE_MAX_BYTES = 50 * 1024;
const PAGE_MAX_TEXT_UNITS = 12_000;
const PAGE_MAX_ENTRIES = 40;

export type EvidencePageEntry = Evidence & { offset: number; continues: boolean };
type EvidencePageItem = Pick<Evidence, 'entryId' | 'role' | 'text' | 'timestamp' | 'editId'> & {
  offset: number;
  continues: boolean;
};
type EvidenceGroup = Pick<
  Evidence,
  'file' | 'sessionId' | 'cwd' | 'branchId' | 'reviewedThrough'
> & {
  entries: EvidencePageItem[];
};
export type PageCursor = { index: number; offset: number };

function serializedResponse(data: object): string {
  const text = JSON.stringify(data);
  if (text === undefined) throw new Error('Remembrancer response is not JSON serializable.');
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > REVIEW_RESPONSE_MAX_BYTES)
    throw new Error(
      `Remembrancer response is ${bytes} UTF-8 bytes, over the ${REVIEW_RESPONSE_MAX_BYTES}-byte limit; metadata or envelope cannot fit.`,
    );
  return text;
}

function fitsResponse(data: object): boolean {
  const text = JSON.stringify(data);
  if (text === undefined) throw new Error('Remembrancer response is not JSON serializable.');
  return Buffer.byteLength(text, 'utf8') <= REVIEW_RESPONSE_MAX_BYTES;
}

function sameGroup(
  a: Pick<Evidence, 'file' | 'sessionId' | 'cwd' | 'branchId' | 'reviewedThrough'>,
  b: Pick<Evidence, 'file' | 'sessionId' | 'cwd' | 'branchId' | 'reviewedThrough'>,
): boolean {
  return (
    a.file === b.file &&
    a.sessionId === b.sessionId &&
    a.cwd === b.cwd &&
    a.branchId === b.branchId &&
    a.reviewedThrough === b.reviewedThrough
  );
}

export function groupEvidencePage(entries: readonly EvidencePageEntry[]): EvidenceGroup[] {
  const groups: EvidenceGroup[] = [];
  for (const entry of entries) {
    let group = groups.at(-1);
    if (!group || !sameGroup(group, entry)) {
      group = {
        file: entry.file,
        sessionId: entry.sessionId,
        cwd: entry.cwd,
        branchId: entry.branchId,
        reviewedThrough: entry.reviewedThrough,
        entries: [],
      };
      groups.push(group);
    }
    group.entries.push({
      entryId: entry.entryId,
      role: entry.role,
      text: entry.text,
      timestamp: entry.timestamp,
      editId: entry.editId,
      offset: entry.offset,
      continues: entry.continues,
    });
  }
  return groups;
}

function splitsSurrogatePair(text: string, boundary: number): boolean {
  if (boundary <= 0 || boundary >= text.length) return false;
  const before = text.charCodeAt(boundary - 1);
  const after = text.charCodeAt(boundary);
  return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff;
}

function safePrefixLength(text: string, start: number, maxUnits: number): number {
  let length = Math.min(maxUnits, text.length - start);
  if (length > 0 && splitsSurrogatePair(text, start + length)) length--;
  return length;
}

export function boundedEvidencePage(
  evidence: readonly Evidence[],
  initial: PageCursor,
  buildResponse: (entries: EvidencePageEntry[], cursor: PageCursor) => Record<string, unknown>,
): { data: Record<string, unknown>; cursor: PageCursor } {
  let { index, offset } = initial;
  const entries: EvidencePageEntry[] = [];
  let remainingText = PAGE_MAX_TEXT_UNITS;

  const candidateFits = (entry: EvidencePageEntry, cursor: PageCursor) =>
    fitsResponse(buildResponse([...entries, entry], cursor));
  const append = (item: Evidence, length: number) => {
    const start = offset;
    const continues = start + length < item.text.length;
    const entry: EvidencePageEntry = {
      ...item,
      text: item.text.slice(start, start + length),
      offset: start,
      continues,
    };
    const cursor = continues ? { index, offset: start + length } : { index: index + 1, offset: 0 };
    if (!candidateFits(entry, cursor)) return false;
    entries.push(entry);
    remainingText -= length;
    ({ index, offset } = cursor);
    return true;
  };

  while (entries.length < PAGE_MAX_ENTRIES && remainingText > 0 && index < evidence.length) {
    const item = evidence[index];
    if (!item) break;
    const wanted = safePrefixLength(item.text, offset, remainingText);

    if (item.text.length === offset) {
      if (!append(item, 0)) {
        if (entries.length === 0)
          throw new Error(
            `Remembrancer response cannot fit a complete evidence entry within the ${REVIEW_RESPONSE_MAX_BYTES}-byte UTF-8 limit; metadata or envelope cannot fit.`,
          );
        break;
      }
      continue;
    }
    if (wanted === 0) break;

    if (append(item, wanted)) {
      if (entries.at(-1)?.continues || remainingText === 0) break;
      continue;
    }

    let low = 0;
    let high = wanted - 1;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      const length = safePrefixLength(item.text, offset, middle);
      if (length > 0) {
        const start = offset;
        const entry: EvidencePageEntry = {
          ...item,
          text: item.text.slice(start, start + length),
          offset: start,
          continues: true,
        };
        if (candidateFits(entry, { index, offset: start + length })) {
          low = middle;
          continue;
        }
      }
      high = middle - 1;
    }
    const length = safePrefixLength(item.text, offset, low);
    if (length > 0 && append(item, length)) break;
    if (entries.length === 0)
      throw new Error(
        `Remembrancer response cannot fit a complete evidence entry within the ${REVIEW_RESPONSE_MAX_BYTES}-byte UTF-8 limit; metadata or envelope cannot fit.`,
      );
    break;
  }

  const cursor = { index, offset };
  const data = buildResponse(entries, cursor);
  serializedResponse(data);
  return { data, cursor };
}

function page(batch: Batch, envelope: Record<string, unknown> = {}) {
  const result = boundedEvidencePage(batch.evidence, batch, (entries, cursor) => ({
    batch: batch.token,
    groups: groupEvidencePage(entries),
    hasMore: cursor.index < batch.evidence.length,
    ...envelope,
  }));
  batch.index = result.cursor.index;
  batch.offset = result.cursor.offset;
  return result.data;
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

function contextPage(batch: string, selected: Selected, items: Evidence[], offset: number) {
  const total = items.reduce((length, item) => length + item.text.length, 0);
  if (offset > total) throw new Error('Context offset is beyond the requested range');

  let index = 0;
  let localOffset = 0;
  let position = 0;
  while (index < items.length) {
    const item = items[index]!;
    if (item.text.length === 0) {
      if (offset === position) break;
      index++;
      continue;
    }
    const end = position + item.text.length;
    if (offset < end) {
      localOffset = offset - position;
      if (splitsSurrogatePair(item.text, localOffset))
        throw new Error('Context offset splits a surrogate pair; use a returned nextOffset.');
      break;
    }
    position = end;
    index++;
  }

  const result = boundedEvidencePage(items, { index, offset: localOffset }, (entries, cursor) => {
    const nextOffset =
      items.slice(0, cursor.index).reduce((length, item) => length + item.text.length, 0) +
      cursor.offset;
    return {
      batch,
      selected,
      contextOnly: true,
      groups: groupEvidencePage(entries),
      nextOffset: nextOffset < total ? nextOffset : null,
    };
  });
  return result.data;
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
      content: [{ type: 'text' as const, text: serializedResponse(data) }],
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
    return page(batch, {
      status,
      warnings,
      incomplete,
      coverageChanged,
      ...(requestedSince === null ? {} : { requestedSince }),
      capturedTips: batch.tips.length,
    });
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
    return contextPage(batch.token, selected, items, offset);
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
        'Read incremental cross-session evidence or finish a fully resolved review. Evidence is grouped by consecutive source and branch metadata. Each complete JSON response is capped at 50 KiB UTF-8. Follow the remembrancer skill and read every page before finishing.',
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

        const reviewedTips = batch.tips.length;
        const finishedBatch = batch;
        const details = resultDetails('finish', finishedBatch);
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
        const responseResult = result(response, details);
        store().finish({
          sources: finishedBatch.stagedSources,
          sourceDefaults: finishedBatch.sourceDefaults,
          checkpoints: finishedBatch.checkpoints,
        });
        release();
        return responseResult;
      },
    });
  }
}

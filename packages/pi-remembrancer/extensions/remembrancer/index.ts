import { randomUUID } from 'node:crypto';
import { access } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { StringEnum, Type } from '@earendil-works/pi-ai';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { CheckpointStore, defaultCheckpointFile } from './checkpoints.js';
import { captureExecution, captureHost, loadRemembrancerConfig } from './config.js';
import { CaptureHandoffError, preserveHandoff } from './capture-handoff.js';
import { launchCaptureWorker } from './capture-worker.js';
import { CAPTURE_MAX_ATTEMPTS, type CaptureStatus } from './capture-jobs.js';
import { readProposalNotice } from './capture-notices.js';
import { openProposals } from './proposal-ui.js';
import { proposalReadDescription, proposalReadParameters, readProposals } from './proposal-read.js';
import { discoverSources } from './discovery.js';
import {
  renderReviewCall,
  renderReviewResult,
  type ReviewResultDetails,
  type ReviewAction,
} from './render.js';
import { copyWarnings, warningMessages, type WarningRecord } from './warnings.js';
import {
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
import {
  boundedEvidencePage,
  frozenContext,
  groupEvidencePage,
  serializedResponse,
  type Selected,
} from './review-pages.js';

export {
  REVIEW_RESPONSE_MAX_BYTES,
  boundedEvidencePage,
  groupEvidencePage,
  type EvidencePageEntry,
  type PageCursor,
} from './review-pages.js';

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
  'Usage: /remembrancer seed <Nd>\n       /remembrancer proposals\n       /remembrancer capture now|status|pause|resume\n       /remembrancer capture retry <full-job-id>\n       /remembrancer help';
export const REMEMBRANCER_HELP = [
  REMEMBRANCER_COMMAND_USAGE,
  'Seed saved-session evidence from a bounded historical window, then follow the Remembrancer skill.',
  'Capture now snapshots the idle saved interactive session and requests a background worker wake; autoCapture must be true and disabled false.',
  'Status, pause, resume and retry remain available when Remembrancer is disabled. Retry requires explicit UI confirmation.',
  'Natural-language review requests remain supported.',
].join('\n');

const CAPTURE_COMMANDS = ['now', 'status', 'pause', 'resume', 'retry'] as const;
const REMEMBRANCER_SUBCOMMANDS = [
  {
    value: 'capture ',
    label: 'capture',
    description: 'Capture this session or control accepted jobs',
  },
  { value: 'proposals', label: 'proposals', description: 'Review stored task proposals locally' },
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
  | { ok: true; mode: 'proposals' }
  | { ok: true; mode: 'seed'; duration: string }
  | { ok: true; mode: 'capture'; action: 'now' }
  | { ok: true; mode: 'capture'; action: 'status' }
  | { ok: true; mode: 'capture'; action: 'pause' }
  | { ok: true; mode: 'capture'; action: 'resume' }
  | { ok: true; mode: 'capture'; action: 'retry'; jobId: string }
  | { ok: false; message: string };

export function parseRemembrancerCommandArgs(args: string): RemembrancerCommandArgs {
  const tokens = args.trim().length === 0 ? [] : args.trim().split(/\s+/u);
  const subcommand = tokens[0];

  if (tokens.length === 0 || (subcommand === 'help' && tokens.length === 1))
    return { ok: true, mode: 'help' };
  if (subcommand === 'proposals' && tokens.length === 1) return { ok: true, mode: 'proposals' };
  if (subcommand === 'capture') {
    const action = tokens[1];
    if (
      (action === 'now' || action === 'status' || action === 'pause' || action === 'resume') &&
      tokens.length === 2
    )
      return { ok: true, mode: 'capture', action };
    if (action === 'retry' && tokens.length === 3)
      return { ok: true, mode: 'capture', action, jobId: tokens[2]! };
    return { ok: false, message: `Invalid capture command. ${REMEMBRANCER_COMMAND_USAGE}` };
  }
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
  if (tokens[0] === 'capture' && (tokens.length === 2 || trailingWhitespace)) {
    if (tokens.length > 2 || (tokens.length === 2 && trailingWhitespace)) return null;
    const partial = tokens.length === 2 ? tokens[1]! : '';
    const matches = CAPTURE_COMMANDS.filter((action) => action.startsWith(partial)).map(
      (action) => ({
        value: `capture ${action}${action === 'retry' ? ' ' : ''}`,
        label: action,
      }),
    );
    return matches.length > 0 ? matches : null;
  }
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

function captureJobStatus(job: CaptureStatus['jobs'][number]): string {
  return [
    job.manifest.id,
    `State: ${job.state}${job.activeAttemptId ? ' (active)' : ''}`,
    `Current allowance: ${job.attemptCount}/${CAPTURE_MAX_ATTEMPTS} attempts used, ${Math.max(0, CAPTURE_MAX_ATTEMPTS - job.attemptCount)} remaining (not lifetime history)`,
    `Stopped reason: ${!job.retryEligible && !job.activeAttemptId ? (job.diagnostic ?? 'none recorded') : 'not stopped'}`,
    `Diagnostic: ${job.diagnostic ?? 'none'}`,
    `Next attempt due: ${job.nextAttemptAt === null ? 'none' : new Date(job.nextAttemptAt).toISOString()}`,
    `Blocked by predecessor: ${job.blockedBy ?? 'none'}`,
  ].join('\n');
}

const selectedParameters = Type.Object({
  sessionId: Type.String(),
  branchId: Type.String(),
  entryId: Type.String(),
  editId: Type.Union([Type.String(), Type.Null()]),
});

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

export const CAPTURE_TICK_MS = 2_000;
export const CAPTURE_RECOVERY_MS = 60_000;

export default function remembrancer(pi: ExtensionAPI) {
  let db: CheckpointStore | undefined;
  let batch: Batch | undefined;
  let stopLifecycle: (() => void) | undefined;
  let noticeGeneration = 0;
  const store = () => (db ??= new CheckpointStore());

  function startLifecycle(ctx: ExtensionContext) {
    stopLifecycle?.();
    if (ctx.mode !== 'tui') return;
    const database = defaultCheckpointFile();
    const inbox = join(dirname(database), 'capture-inbox');
    const host = captureHost();
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let nextWake = 0;
    stopLifecycle = () => {
      stopped = true;
      clearTimeout(timer);
    };
    // Recursive scheduling gives one async tick, never overlapping slow reads/launches.
    async function tick() {
      try {
        const notice = await readProposalNotice(database);
        if (stopped) return;
        if (notice && notice.generation > noticeGeneration) {
          noticeGeneration = notice.generation;
          if (notice.pending)
            ctx.ui.notify(`${notice.pending} task proposals · /remembrancer proposals`, 'info');
        }
      } catch {
        // A missing/corrupt derived notice cannot suppress recovery of accepted work.
      }
      if (stopped) return;
      if (Date.now() >= nextWake) {
        nextWake = Date.now() + CAPTURE_RECOVERY_MS;
        try {
          await access(database).catch(async (error: NodeJS.ErrnoException) => {
            if (error.code !== 'ENOENT') throw error;
            await access(inbox);
          });
          if (stopped) return;
          await launchCaptureWorker(database, inbox, host);
        } catch {
          // Failed launch/crash is retried on a later bounded wake, not a chat turn.
        }
      }
      if (!stopped) {
        timer = setTimeout(() => void tick(), CAPTURE_TICK_MS);
        timer.unref();
      }
    }
    void tick();
  }

  async function wakeCapture(ctx: ExtensionContext) {
    const database = defaultCheckpointFile();
    try {
      await launchCaptureWorker(database, join(dirname(database), 'capture-inbox'), captureHost());
    } catch {
      ctx.ui.notify(
        'Capture state saved; worker launch failed. A later wake can recover it.',
        'warning',
      );
    }
  }

  async function controlCapture(
    parsed: Extract<RemembrancerCommandArgs, { mode: 'capture' }>,
    ctx: ExtensionContext,
  ) {
    try {
      if (parsed.action === 'now') {
        if (ctx.mode !== 'tui' || !ctx.hasUI)
          throw new Error('Capture now requires an interactive Pi terminal.');
        if (!ctx.isIdle())
          throw new Error(
            'Pi is busy. Wait for the current run to finish, then retry capture now.',
          );
        const source = currentSource(ctx);
        if (!source) throw new Error('Capture now requires a saved Pi session.');
        const config = loadRemembrancerConfig(ctx.cwd, ctx.isProjectTrusted());
        if (config.disabled || !config.autoCapture)
          throw new Error(
            'Capture now requires pi-remembrancer.autoCapture true and pi-remembrancer.disabled false in settings.',
          );
        const database = defaultCheckpointFile();
        const accepted = await preserveHandoff({
          id: randomUUID(),
          inbox: join(dirname(database), 'capture-inbox'),
          source,
          execution: captureExecution(ctx),
        });
        await wakeCapture(ctx);
        ctx.ui.notify(
          `Capture accepted: ${accepted.manifest.id}. Worker wake requested; review may wait. Check /remembrancer capture status and /remembrancer proposals.${accepted.cleanupDiagnostic ? `\n${accepted.cleanupDiagnostic}` : ''}`,
          accepted.cleanupDiagnostic ? 'warning' : 'info',
        );
        return;
      }
      if (parsed.action === 'status') {
        const status = store().captureStatus();
        ctx.ui.notify(
          [
            `Capture: ${status.paused ? 'paused' : 'running permitted'}`,
            ...(status.jobs.length ? status.jobs.map(captureJobStatus) : ['No unresolved jobs.']),
          ].join('\n\n'),
          'info',
        );
        return;
      }
      if (parsed.action === 'pause' || parsed.action === 'resume') {
        store().setCapturePaused(parsed.action === 'pause');
        ctx.ui.notify(
          parsed.action === 'pause'
            ? 'Capture paused. Active attempts revoked; cancellation is observed by the worker.'
            : 'Capture resumed. Existing allowances, delays and predecessor ordering are unchanged.',
          'info',
        );
        if (parsed.action === 'resume') await wakeCapture(ctx);
        return;
      }
      if (ctx.mode !== 'tui' || !ctx.hasUI)
        throw new Error(
          'Capture retry requires explicit UI confirmation. No retry was authorized.',
        );
      const status = store().captureStatus();
      const job = status.jobs.find((job) => job.manifest.id === parsed.jobId);
      if (!job) throw new Error('No unresolved capture job with that exact full ID.');
      if (job.state !== 'failed' || job.retryEligible || job.activeAttemptId)
        throw new Error('Only stopped, inactive capture jobs can be deliberately retried.');
      const confirmed = await ctx.ui.confirm(
        'Retry capture job?',
        `${captureJobStatus(job)}\n\nReplace the current allowance with ${CAPTURE_MAX_ATTEMPTS} fresh whole-review attempts? Capture ${status.paused ? 'is paused and stays paused' : 'pause state is unchanged'}. Predecessors still block this job.`,
      );
      if (!confirmed) {
        ctx.ui.notify('Capture retry cancelled. No allowance changed.', 'info');
        return;
      }
      store().retryCaptureJob(parsed.jobId, job.revision);
      ctx.ui.notify(
        `Capture retry queued: ${parsed.jobId}. Pause and predecessor ordering are unchanged.`,
        'info',
      );
      await wakeCapture(ctx);
    } catch (error) {
      ctx.ui.notify(
        `Capture control failed: ${error instanceof Error ? error.message : String(error)}`,
        'error',
      );
    }
  }

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
    description: 'Review proposals, seed history, capture this session or control capture jobs',
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
      if (parsed.mode === 'capture') {
        await controlCapture(parsed, ctx);
        return;
      }
      if (loadRemembrancerConfig(ctx.cwd, ctx.isProjectTrusted()).disabled) {
        ctx.ui.notify(
          'Remembrancer is disabled in settings. Set pi-remembrancer.disabled to false to enable it.',
          'warning',
        );
        return;
      }
      if (parsed.mode === 'proposals') {
        if (ctx.mode !== 'tui') throw new Error('Task proposals require TUI mode');
        await openProposals(ctx, store());
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
    return frozenContext(batch, batch.token, args);
  }

  pi.on('session_start', (_event, ctx) => {
    // Recovery/notices are independent of authorization for NEW handoffs.
    startLifecycle(ctx);
    if (loadRemembrancerConfig(ctx.cwd, ctx.isProjectTrusted()).disabled) return;
    registerReviewTool();
    pi.registerTool({
      name: 'remembrancer_proposals',
      label: 'Remembrancer proposals',
      description: proposalReadDescription,
      parameters: proposalReadParameters,
      async execute(_id, args) {
        const data = readProposals(store(), args);
        return {
          content: [{ type: 'text', text: serializedResponse(data) }],
          details: {},
        };
      },
    });
    enroll(ctx);
    if (ctx.mode === 'tui') {
      const notice = store().proposalNotice();
      noticeGeneration = notice.generation;
      if (notice.pending)
        ctx.ui.notify(`${notice.pending} task proposals · /remembrancer proposals`, 'info');
    }
  });
  pi.on('session_shutdown', async (event, ctx) => {
    stopLifecycle?.();
    let phase = 'manual-release';
    let artifactId = 'no-handoff';
    try {
      try {
        // Abandon unfinished manual coverage; the worker never inherits that lock.
        release();
        const source = ctx.mode === 'tui' ? currentSource(ctx) : undefined;
        if (source) {
          phase = 'admission-configuration';
          const config = loadRemembrancerConfig(ctx.cwd, ctx.isProjectTrusted());
          if (config.autoCapture && !config.disabled) {
            artifactId = randomUUID();
            const execution = captureExecution(ctx);
            const database = defaultCheckpointFile();
            const inbox = join(dirname(database), 'capture-inbox');
            phase = 'preservation';
            const accepted = await preserveHandoff({ id: artifactId, inbox, source, execution });
            if (accepted.cleanupDiagnostic) {
              try {
                ctx.ui.notify(
                  `Remembrancer accepted capture: ${accepted.cleanupDiagnostic}`,
                  'warning',
                );
              } catch {
                // Notification failure cannot revoke acceptance or suppress launch.
              }
            }
            // A failed launch leaves the durable ready manifest for the next wake.
            phase = 'worker-launch';
            await launchCaptureWorker(database, inbox, execution.host!);
          }
        }
      } finally {
        try {
          const previousPhase = phase;
          phase = 'foreground-close';
          db?.close();
          phase = previousPhase;
        } finally {
          db = undefined;
        }
      }
    } catch (error) {
      const detail =
        error instanceof CaptureHandoffError
          ? error.message
          : new CaptureHandoffError(phase, 'shutdown-failed', artifactId, error).message;
      ctx.ui.notify(`Remembrancer shutdown (${event.reason}) failed:\n${detail}`, 'warning');
    }
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

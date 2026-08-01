import { execFile as execFileCallback } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { link, mkdir, open, readFile, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { formatPosixCommand } from '../identity/terminal-focus.js';
import { normalizeIdentityRecord } from '../identity/reader.js';
import { getIdentityRecordPath } from '../identity/store.js';
import { checkPidExists, readPidStartedAt, type PidExistenceProbe } from '../presence/pid.js';
import { normalizePresenceRecord } from '../presence/reader.js';
import { getPresenceRecordPath } from '../presence/store.js';
import { PI_SESSION_DECK_ASSIGNED_RUNTIME_ID_ENV } from '../presence/constants.js';
import { readDescendantPids } from './process.js';
import {
  assertExecutable,
  createRestartGeneration,
  getDefaultRestartDirectory,
  getRestartJournalPath,
  getRestartLockPath,
  normalizeRestartSessionRequest,
  readRestartJournal,
  removeRestartJournal,
  readRestartRecipe,
  writePrivateJson,
  writeRestartJournal,
} from './store.js';
import type {
  ManagedRestartRecipeV1,
  RestartJournalV1,
  RestartJournalState,
  RestartReasonCode,
  RestartSessionRequest,
  RestartSessionResult,
  RestartSessionStatus,
} from './types.js';

const execFile = promisify(execFileCallback);
export const RESTART_TERM_GRACE_MS = 2_000;
export const RESTART_KILL_GRACE_MS = 2_000;
export const RESTART_PANE_DEAD_WAIT_MS = 2_000;
export const RESTART_OBSERVE_MS = 8_000;
export const RESTART_INTERNAL_OPERATION_MS = 20_000;
const POLL_MS = 100;
const TMUX_SEPARATOR = '\u001f';

interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}
export type RestartExec = (
  file: string,
  args: readonly string[],
  options: { signal: AbortSignal },
) => Promise<CommandResult>;
type Signal = (pid: number, signal: NodeJS.Signals) => void;

export interface RestartSessionOptions {
  restartDirectory?: string;
  presenceDirectory?: string;
  identityDirectory?: string;
  hostingRuntimeId?: string;
  currentPid?: number;
  now?: () => Date;
  exec?: RestartExec;
  signal?: Signal;
  readPidStartedAt?: typeof readPidStartedAt;
  probePidExists?: PidExistenceProbe;
  sleep?: (ms: number) => Promise<void>;
  termGraceMs?: number;
  killGraceMs?: number;
  paneDeadWaitMs?: number;
  observeMs?: number;
  internalOperationMs?: number;
  operationDeadlineAt?: number;
}

interface PaneState {
  dead: boolean;
  pid: number;
  sessionName: string;
  windowIndex: number;
  paneIndex: number;
  paneId: string;
  socketPath: string;
  cwd: string;
}

interface PreparedRestart {
  recipe: ManagedRestartRecipeV1 & { binding: NonNullable<ManagedRestartRecipeV1['binding']> };
  presenceStartedAt: string;
  pane: PaneState;
}

type GenerationInspection = 'matches' | 'missing' | 'reused' | 'unverified';
type GenerationExitState = 'gone' | 'alive' | 'unverified';
type SignalResult = 'sent' | 'gone' | 'unverified' | 'failed';

export async function restartSessionDeckRuntime(
  requestCandidate: RestartSessionRequest | unknown,
  options: RestartSessionOptions = {},
): Promise<RestartSessionResult> {
  const request = normalizeRestartSessionRequest(requestCandidate);
  if (request === null) throw new Error('Invalid restart-session request.');
  options = {
    ...options,
    operationDeadlineAt:
      options.operationDeadlineAt ??
      Date.now() + (options.internalOperationMs ?? RESTART_INTERNAL_OPERATION_MS),
  };
  const directory = options.restartDirectory ?? getDefaultRestartDirectory();
  if (
    request.runtimeId === options.hostingRuntimeId ||
    request.runtimeId === process.env['PI_SESSION_DECK_RUNTIME_ID']
  )
    return result('not-eligible', request, 'hosting-runtime', false);
  const lock = await acquireRuntimeLock(request, directory, options);
  if (!lock.ok) return result('already-in-progress', request, 'operation-in-progress', true);

  let journal: RestartJournalV1 | null = null;
  let keepRetainedPane = false;
  try {
    const recorded = await readRestartJournal(request.runtimeId, directory);
    if (recorded?.operationId === request.operationId && recorded.generation !== request.generation)
      return result('stale-generation', request, 'generation-changed', false);
    if (recorded !== null && recorded.operationId !== request.operationId) {
      if (isUnresolved(recorded.state))
        return result('already-in-progress', request, 'operation-in-progress', true);
    } else {
      journal = recorded;
    }

    if (journal !== null) {
      const terminal = terminalResult(journal);
      if (terminal !== null) return terminal;
      if (['stopped', 'stopped-not-restarted'].includes(journal.state)) {
        const response = await continueStoppedRestart(request, journal, options, directory);
        keepRetainedPane = response.status === 'stopped-not-restarted';
        return response;
      }
      if (['spawn-requested', 'observing', 'outcome-unknown'].includes(journal.state)) {
        const response = await reconcileSpawnedRestart(request, journal, options, directory);
        keepRetainedPane = await shouldKeepRetainedPane(response, journal, options, directory);
        return response;
      }
      if (journal.state === 'term-sent' || journal.state === 'kill-sent') {
        const response = await reconcileStoppedProcess(request, journal, options, directory);
        keepRetainedPane = response.status === 'stopped-not-restarted';
        return response;
      }
      if (journal.state === 'preparing') {
        await cleanupPreparingRestart(journal, options, directory);
        journal = null;
      }
    }

    const prepared = await preflightRestart(request, options, directory);
    if (!prepared.ok) return prepared.result;
    if (prepared.value.recipe.binding.pid === (options.currentPid ?? process.pid)) {
      return result('not-eligible', request, 'coordinator-runtime', false);
    }

    journal = {
      schemaVersion: 1,
      runtimeId: request.runtimeId,
      generation: request.generation,
      operationId: request.operationId,
      state: 'preparing',
      coordinator: lock.coordinator,
      oldPid: prepared.value.recipe.binding.pid,
      oldOsProcessStartedAt: prepared.value.recipe.binding.osProcessStartedAt,
      oldPresenceStartedAt: prepared.value.presenceStartedAt,
      pane: journalPane(prepared.value.pane),
      updatedAt: now(options),
    };
    await writeRestartJournal(journal, directory);

    const previousRemainOnExit = await readRemainOnExit(
      prepared.value.recipe,
      options,
      prepared.value.pane,
    );
    if (previousRemainOnExit === null) {
      await removeRestartJournal(request.runtimeId, directory);
      journal = null;
      return result('not-eligible', request, 'tmux-target-unavailable', false);
    }
    journal = { ...journal, previousRemainOnExit, updatedAt: now(options) };
    await writeRestartJournal(journal, directory);
    if (!(await setRemainOnExit(prepared.value.recipe, 'on', options, prepared.value.pane))) {
      await cleanupPreparingRestart(journal, options, directory, prepared.value.recipe);
      journal = null;
      return result('not-eligible', request, 'tmux-target-unavailable', false);
    }

    const rechecked = await inspectPane(prepared.value.recipe, options, prepared.value.pane);
    const recheckedGeneration = await inspectGeneration(
      journal.oldPid,
      journal.oldOsProcessStartedAt,
      options,
    );
    if (
      rechecked === null ||
      rechecked.dead ||
      !paneMatches(rechecked, prepared.value.recipe, prepared.value.pane) ||
      rechecked.pid !== journal.oldPid ||
      recheckedGeneration !== 'matches'
    ) {
      await cleanupPreparingRestart(journal, options, directory, prepared.value.recipe);
      journal = null;
      return recheckedGeneration === 'unverified'
        ? result('not-eligible', request, 'runtime-unavailable', true)
        : result('stale-generation', request, 'generation-changed', false);
    }

    journal = await transition(journal, 'term-sent', directory);
    const term = await signalExactGeneration(
      journal.oldPid,
      journal.oldOsProcessStartedAt,
      'SIGTERM',
      options,
    );
    let exitState: GenerationExitState;
    if (term === 'gone') {
      exitState = 'gone';
    } else if (term !== 'sent') {
      journal = await terminalTransition(journal, 'stop-failed', 'termination-failed', directory);
      return result('stop-failed', request, 'termination-failed', true);
    } else {
      exitState = await waitForGenerationExit(
        journal.oldPid,
        journal.oldOsProcessStartedAt,
        options.termGraceMs ?? RESTART_TERM_GRACE_MS,
        options,
      );
    }
    if (exitState === 'alive') {
      if ((await inspectDescendantPids(journal.oldPid, options)).length > 0) {
        journal = await terminalTransition(journal, 'stop-failed', 'unsafe-descendants', directory);
        return result('stop-failed', request, 'unsafe-descendants', true);
      }
      const beforeKill = await inspectGeneration(
        journal.oldPid,
        journal.oldOsProcessStartedAt,
        options,
      );
      if (isGenerationGone(beforeKill)) {
        exitState = 'gone';
      } else if (beforeKill === 'unverified') {
        exitState = 'unverified';
      } else {
        journal = await transition(journal, 'kill-sent', directory);
        const kill = await signalExactGeneration(
          journal.oldPid,
          journal.oldOsProcessStartedAt,
          'SIGKILL',
          options,
        );
        if (kill === 'gone') {
          exitState = 'gone';
        } else if (kill !== 'sent') {
          exitState = 'unverified';
        } else {
          exitState = await waitForGenerationExit(
            journal.oldPid,
            journal.oldOsProcessStartedAt,
            options.killGraceMs ?? RESTART_KILL_GRACE_MS,
            options,
          );
        }
      }
    }
    if (exitState !== 'gone') {
      journal = await terminalTransition(journal, 'stop-failed', 'termination-failed', directory);
      return result('stop-failed', request, 'termination-failed', true);
    }
    if (
      !(await waitForPaneDead(
        prepared.value.recipe,
        options.paneDeadWaitMs ?? RESTART_PANE_DEAD_WAIT_MS,
        options,
        prepared.value.pane,
      ))
    ) {
      journal = await terminalTransition(
        journal,
        'stopped-not-restarted',
        'pane-did-not-stop',
        directory,
      );
      keepRetainedPane = true;
      return result('stopped-not-restarted', request, 'pane-did-not-stop', true);
    }

    journal = await transition(journal, 'stopped', directory);
    const spawnResult = await spawnReplacement(prepared.value.recipe, journal, options, directory);
    if (spawnResult.status !== 'restarted')
      keepRetainedPane = await shouldKeepRetainedPane(spawnResult, journal, options, directory);
    return spawnResult;
  } catch {
    const persisted = await readRestartJournal(request.runtimeId, directory);
    if (
      persisted?.operationId === request.operationId &&
      persisted.generation === request.generation
    )
      journal = persisted;

    if (journal?.state === 'term-sent' || journal?.state === 'kill-sent') {
      journal = await terminalTransition(journal, 'stop-failed', 'termination-failed', directory);
      return result('stop-failed', request, 'termination-failed', true);
    }
    if (
      journal !== null &&
      [
        'stopped',
        'stopped-not-restarted',
        'spawn-requested',
        'observing',
        'outcome-unknown',
      ].includes(journal.state)
    ) {
      const activeJournal = journal;
      journal =
        activeJournal.state === 'outcome-unknown'
          ? activeJournal
          : await terminalTransition(
              activeJournal,
              'outcome-unknown',
              'operation-state-unknown',
              directory,
            );
      const response = result('outcome-unknown', request, 'operation-state-unknown', true);
      keepRetainedPane = await shouldKeepRetainedPane(response, journal, options, directory);
      return response;
    }
    if (journal?.state === 'preparing') {
      await cleanupPreparingRestart(journal, options, directory);
      journal = null;
    }
    throw new Error('Restart operation failed before process mutation.');
  } finally {
    if (!keepRetainedPane && journal?.previousRemainOnExit !== undefined) {
      const recipe = await readRestartRecipe(request.runtimeId, directory);
      if (recipe !== null)
        await restoreRemainOnExit(
          recipe,
          journal.previousRemainOnExit,
          options,
          journal.pane,
        ).catch(() => undefined);
    }
    await lock.release().catch(() => undefined);
  }
}

async function preflightRestart(
  request: RestartSessionRequest,
  options: RestartSessionOptions,
  directory: string,
): Promise<{ ok: true; value: PreparedRestart } | { ok: false; result: RestartSessionResult }> {
  const recipe = await readRestartRecipe(request.runtimeId, directory);
  if (recipe === null)
    return {
      ok: false,
      result: result('not-eligible', request, 'managed-recipe-unavailable', false),
    };
  if (recipe.binding === undefined)
    return { ok: false, result: result('not-eligible', request, 'recipe-not-bound', false) };
  const generation = createRestartGeneration(
    request.runtimeId,
    recipe.binding.pid,
    recipe.binding.osProcessStartedAt,
  );
  if (generation !== request.generation)
    return { ok: false, result: result('stale-generation', request, 'generation-changed', false) };

  const presencePath = getPresenceRecordPath(request.runtimeId, options.presenceDirectory);
  if (!(await isCurrentUserFile(presencePath))) {
    return { ok: false, result: result('not-eligible', request, 'runtime-unavailable', true) };
  }
  const presence = await readJson(presencePath);
  const normalizedPresence = normalizePresenceRecord(presence);
  if (
    normalizedPresence === null ||
    normalizedPresence.runtimeId !== request.runtimeId ||
    normalizedPresence.pid !== recipe.binding.pid
  ) {
    return { ok: false, result: result('not-eligible', request, 'runtime-unavailable', true) };
  }
  const generationInspection = await inspectGeneration(
    recipe.binding.pid,
    recipe.binding.osProcessStartedAt,
    options,
  );
  if (generationInspection !== 'matches') {
    return {
      ok: false,
      result:
        generationInspection === 'unverified'
          ? result('not-eligible', request, 'runtime-unavailable', true)
          : result('stale-generation', request, 'generation-changed', false),
    };
  }
  const identityPath = getIdentityRecordPath(request.runtimeId, options.identityDirectory);
  if (!(await isCurrentUserFile(identityPath))) {
    return { ok: false, result: result('not-eligible', request, 'identity-mismatch', false) };
  }
  const identity = normalizeIdentityRecord(await readJson(identityPath));
  if (
    identity === null ||
    identity.runtimeId !== request.runtimeId ||
    identity.sessionId !== recipe.binding.sessionId ||
    identity.sessionFile !== recipe.binding.sessionFile ||
    identity.cwd !== recipe.cwd
  ) {
    return { ok: false, result: result('not-eligible', request, 'identity-mismatch', false) };
  }
  if (!(await isCurrentUserFile(recipe.binding.sessionFile))) {
    return {
      ok: false,
      result: result('not-eligible', request, 'session-file-unavailable', false),
    };
  }
  const header = await readSessionHeader(recipe.binding.sessionFile);
  if (header === null || header.id !== recipe.binding.sessionId || header.cwd !== recipe.cwd) {
    return {
      ok: false,
      result: result('not-eligible', request, 'session-file-unavailable', false),
    };
  }
  try {
    if (!(await stat(recipe.cwd)).isDirectory()) throw new Error();
  } catch {
    return { ok: false, result: result('not-eligible', request, 'cwd-unavailable', false) };
  }
  if (!(await assertExecutable(recipe.launch.piExecutable)))
    return {
      ok: false,
      result: result('not-eligible', request, 'pi-executable-unavailable', false),
    };
  const pane = await inspectPane(recipe, options);
  if (pane === null || pane.dead)
    return { ok: false, result: result('not-eligible', request, 'tmux-target-unavailable', false) };
  if (!paneMatches(pane, recipe) || pane.pid !== recipe.binding.pid || pane.cwd !== recipe.cwd)
    return { ok: false, result: result('not-eligible', request, 'tmux-pane-mismatch', false) };
  if ((await inspectDescendantPids(recipe.binding.pid, options)).length > 0)
    return { ok: false, result: result('not-eligible', request, 'unsafe-descendants', true) };
  return {
    ok: true,
    value: {
      recipe: recipe as PreparedRestart['recipe'],
      presenceStartedAt: normalizedPresence.startedAt,
      pane,
    },
  };
}

async function spawnReplacement(
  recipe: PreparedRestart['recipe'],
  journal: RestartJournalV1,
  options: RestartSessionOptions,
  directory: string,
): Promise<RestartSessionResult> {
  const pane = await inspectPane(recipe, options, journal.pane);
  if (pane === null || !pane.dead || !paneMatches(pane, recipe, journal.pane)) {
    if (journal.state === 'stopped')
      await terminalTransition(
        journal,
        'stopped-not-restarted',
        'tmux-target-unavailable',
        directory,
      );
    return result('stopped-not-restarted', journal, 'tmux-target-unavailable', true);
  }
  journal = await transition(journal, 'spawn-requested', directory);
  const command = buildRestartCommand(recipe);
  const spawn = await runTmux(
    recipe,
    ['respawn-pane', '-t', tmuxTarget(recipe, journal.pane), '-c', recipe.cwd, command],
    options,
  );
  if (spawn.exitCode !== 0) {
    await terminalTransition(journal, 'stopped-not-restarted', 'respawn-failed', directory);
    return result('stopped-not-restarted', journal, 'respawn-failed', true);
  }
  journal = await transition(journal, 'observing', directory);
  const observed = await observeReplacement(recipe, journal, options, directory);
  if (!observed) {
    await terminalTransition(journal, 'outcome-unknown', 'replacement-unobserved', directory);
    return result('outcome-unknown', journal, 'replacement-unobserved', true);
  }
  await terminalTransition(journal, 'restarted', 'replacement-observed', directory);
  return result('restarted', journal, 'replacement-observed', false);
}

async function reconcileStoppedProcess(
  request: RestartSessionRequest,
  journal: RestartJournalV1,
  options: RestartSessionOptions,
  directory: string,
): Promise<RestartSessionResult> {
  const recipe = await readRestartRecipe(request.runtimeId, directory);
  if (recipe?.binding === undefined || recipe.binding.pid !== journal.oldPid)
    return result('stale-generation', request, 'generation-changed', false);
  const oldGeneration = await inspectGeneration(
    journal.oldPid,
    journal.oldOsProcessStartedAt,
    options,
  );
  if (oldGeneration === 'matches') {
    await terminalTransition(journal, 'stop-failed', 'termination-failed', directory);
    return result('stop-failed', request, 'termination-failed', true);
  }
  if (oldGeneration === 'unverified') {
    await terminalTransition(journal, 'stop-failed', 'termination-failed', directory);
    return result('stop-failed', request, 'termination-failed', true);
  }
  const pane = await inspectPane(recipe, options, journal.pane);
  if (pane === null || !pane.dead || !paneMatches(pane, recipe, journal.pane)) {
    await terminalTransition(journal, 'stopped-not-restarted', 'pane-did-not-stop', directory);
    return result('stopped-not-restarted', request, 'pane-did-not-stop', true);
  }
  const stopped = await transition(journal, 'stopped', directory);
  return await continueStoppedRestart(request, stopped, options, directory);
}

async function shouldKeepRetainedPane(
  response: RestartSessionResult,
  journal: RestartJournalV1,
  options: RestartSessionOptions,
  directory: string,
): Promise<boolean> {
  if (response.status === 'stopped-not-restarted') return true;
  if (response.status !== 'outcome-unknown') return false;
  const recipe = await readRestartRecipe(journal.runtimeId, directory);
  if (recipe === null) return true;
  try {
    const pane = await inspectPane(recipe, options, journal.pane);
    return pane === null || (pane.dead && paneMatches(pane, recipe, journal.pane));
  } catch {
    return true;
  }
}

function journalPane(pane: PaneState): NonNullable<RestartJournalV1['pane']> {
  return {
    id: pane.paneId,
    socketPath: pane.socketPath,
    sessionName: pane.sessionName,
    windowIndex: pane.windowIndex,
    paneIndex: pane.paneIndex,
  };
}

async function continueStoppedRestart(
  request: RestartSessionRequest,
  journal: RestartJournalV1,
  options: RestartSessionOptions,
  directory: string,
): Promise<RestartSessionResult> {
  const recipe = await readRestartRecipe(request.runtimeId, directory);
  if (recipe?.binding === undefined)
    return result('stale-generation', request, 'generation-changed', false);
  const oldGeneration = await inspectGeneration(
    journal.oldPid,
    journal.oldOsProcessStartedAt,
    options,
  );
  if (oldGeneration === 'unverified' || oldGeneration === 'matches')
    return result('outcome-unknown', request, 'operation-state-unknown', true);
  if (isReplacementGeneration(recipe.binding, journal)) {
    const replacement = await inspectGeneration(
      recipe.binding.pid,
      recipe.binding.osProcessStartedAt,
      options,
    );
    if (!isGenerationGone(replacement))
      return result('outcome-unknown', request, 'operation-state-unknown', true);
  }
  const pane = await inspectPane(recipe, options, journal.pane);
  if (pane === null || !pane.dead || !paneMatches(pane, recipe, journal.pane))
    return result('outcome-unknown', request, 'operation-state-unknown', true);
  return await spawnReplacement(recipe as PreparedRestart['recipe'], journal, options, directory);
}

async function reconcileSpawnedRestart(
  request: RestartSessionRequest,
  journal: RestartJournalV1,
  options: RestartSessionOptions,
  directory: string,
): Promise<RestartSessionResult> {
  const recipe = await readRestartRecipe(request.runtimeId, directory);
  if (recipe?.binding === undefined || recipe.binding.sessionId.length === 0)
    return result('outcome-unknown', request, 'operation-state-unknown', true);

  if (
    isReplacementGeneration(recipe.binding, journal) &&
    (await observeReplacement(recipe as PreparedRestart['recipe'], journal, options, directory))
  ) {
    await terminalTransition(journal, 'restarted', 'replacement-observed', directory);
    return result('restarted', request, 'replacement-observed', false);
  }

  const oldGeneration = await inspectGeneration(
    journal.oldPid,
    journal.oldOsProcessStartedAt,
    options,
  );
  if (!isGenerationGone(oldGeneration))
    return result('outcome-unknown', request, 'operation-state-unknown', true);

  if (isReplacementGeneration(recipe.binding, journal)) {
    const replacement = await inspectGeneration(
      recipe.binding.pid,
      recipe.binding.osProcessStartedAt,
      options,
    );
    if (!isGenerationGone(replacement))
      return result('outcome-unknown', request, 'replacement-unobserved', true);
  }

  const pane = await inspectPane(recipe, options, journal.pane);
  if (pane === null || !pane.dead || !paneMatches(pane, recipe, journal.pane))
    return result('outcome-unknown', request, 'replacement-unobserved', true);

  const stopped = await terminalTransition(
    journal,
    'stopped-not-restarted',
    'replacement-unobserved',
    directory,
  );
  return await continueStoppedRestart(request, stopped, options, directory);
}

export function buildRestartCommand(recipe: PreparedRestart['recipe']): string {
  const envArgs = [`PATH=${recipe.launch.effectivePath}`];
  if (
    recipe.launch.agentDir.mode === 'default' ||
    (recipe.launch.agentDir.mode === 'ambient' && recipe.launch.agentDir.path === undefined)
  )
    envArgs.unshift('-u', 'PI_CODING_AGENT_DIR');
  else if (recipe.launch.agentDir.path !== undefined)
    envArgs.push(`PI_CODING_AGENT_DIR=${recipe.launch.agentDir.path}`);
  if (recipe.launch.sessionDir === undefined) envArgs.unshift('-u', 'PI_CODING_AGENT_SESSION_DIR');
  else envArgs.push(`PI_CODING_AGENT_SESSION_DIR=${recipe.launch.sessionDir.path}`);
  envArgs.push(`${PI_SESSION_DECK_ASSIGNED_RUNTIME_ID_ENV}=${recipe.runtimeId}`);
  const argv = [
    '/usr/bin/env',
    ...envArgs,
    recipe.launch.piExecutable,
    ...(recipe.launch.sessionDir === undefined
      ? []
      : ['--session-dir', recipe.launch.sessionDir.path]),
    '--session',
    recipe.binding.sessionFile,
  ];
  return `exec ${formatPosixCommand(argv)}`;
}

function isReplacementGeneration(
  binding: NonNullable<ManagedRestartRecipeV1['binding']>,
  journal: RestartJournalV1,
): boolean {
  return (
    binding.pid !== journal.oldPid || binding.osProcessStartedAt !== journal.oldOsProcessStartedAt
  );
}

async function observeReplacement(
  recipe: PreparedRestart['recipe'],
  journal: RestartJournalV1,
  options: RestartSessionOptions,
  directory: string,
): Promise<boolean> {
  const deadline = Math.min(
    Date.now() + (options.observeMs ?? RESTART_OBSERVE_MS),
    options.operationDeadlineAt ?? Number.POSITIVE_INFINITY,
  );
  while (Date.now() < deadline) {
    const rebound = await readRestartRecipe(recipe.runtimeId, directory);
    const presence = normalizePresenceRecord(
      await readJson(getPresenceRecordPath(recipe.runtimeId, options.presenceDirectory)),
    );
    const pane = await inspectPane(recipe, options, journal.pane);
    if (
      rebound?.binding !== undefined &&
      rebound.binding.sessionId === recipe.binding.sessionId &&
      rebound.binding.sessionFile === recipe.binding.sessionFile &&
      isReplacementGeneration(rebound.binding, journal) &&
      (await inspectGeneration(
        rebound.binding.pid,
        rebound.binding.osProcessStartedAt,
        options,
      )) === 'matches' &&
      rebound.cwd === recipe.cwd &&
      presence?.runtimeId === recipe.runtimeId &&
      presence?.pid === rebound.binding.pid &&
      presence.startedAt !== journal.oldPresenceStartedAt &&
      Date.now() - Date.parse(presence.heartbeatAt) < 30_000 &&
      pane !== null &&
      !pane.dead &&
      pane.pid === rebound.binding.pid &&
      paneMatches(pane, recipe, journal.pane)
    )
      return true;
    await sleep(options, POLL_MS);
  }
  return false;
}

async function inspectPane(
  recipe: ManagedRestartRecipeV1,
  options: RestartSessionOptions,
  expected?: RestartJournalV1['pane'] | PaneState,
): Promise<PaneState | null> {
  const output = await runTmux(
    recipe,
    [
      'display-message',
      '-p',
      '-t',
      tmuxTarget(recipe, expected),
      [
        '#{pane_dead}',
        '#{pane_pid}',
        '#{session_name}',
        '#{window_index}',
        '#{pane_index}',
        '#{pane_id}',
        '#{socket_path}',
        '#{pane_current_path}',
      ].join(TMUX_SEPARATOR),
    ],
    options,
  );
  if (output.exitCode !== 0) return null;
  const [dead, pid, sessionName, windowIndex, paneIndex, paneId, socketPath, cwd] = output.stdout
    .trimEnd()
    .split(TMUX_SEPARATOR);
  const isDead = dead === '1';
  const verifiedCwd = cwd || (isDead ? recipe.cwd : '');
  if (
    !['0', '1'].includes(dead ?? '') ||
    !/^\d+$/u.test(pid ?? '') ||
    !/^\d+$/u.test(windowIndex ?? '') ||
    !/^\d+$/u.test(paneIndex ?? '') ||
    !paneId?.startsWith('%') ||
    !socketPath ||
    !verifiedCwd
  )
    return null;
  return {
    dead: isDead,
    pid: Number(pid),
    sessionName: sessionName!,
    windowIndex: Number(windowIndex),
    paneIndex: Number(paneIndex),
    paneId,
    socketPath,
    cwd: verifiedCwd,
  };
}

function paneMatches(
  pane: PaneState,
  recipe: ManagedRestartRecipeV1,
  expected?: RestartJournalV1['pane'] | PaneState,
): boolean {
  return (
    pane.sessionName === recipe.tmux.sessionName &&
    pane.windowIndex === recipe.tmux.windowIndex &&
    pane.paneIndex === recipe.tmux.paneIndex &&
    (recipe.tmux.socketSelector.startsWith('path:')
      ? pane.socketPath === recipe.tmux.socketSelector.slice('path:'.length)
      : true) &&
    (expected === undefined ||
      (pane.paneId === ('paneId' in expected ? expected.paneId : expected.id) &&
        pane.socketPath === expected.socketPath &&
        pane.sessionName === expected.sessionName &&
        pane.windowIndex === expected.windowIndex &&
        pane.paneIndex === expected.paneIndex))
  );
}
function tmuxTarget(
  recipe: ManagedRestartRecipeV1,
  expected?: RestartJournalV1['pane'] | PaneState,
): string {
  if (expected !== undefined) return 'paneId' in expected ? expected.paneId : expected.id;
  return `=${recipe.tmux.sessionName}:${recipe.tmux.windowIndex}.${recipe.tmux.paneIndex}`;
}
async function runTmux(
  recipe: ManagedRestartRecipeV1,
  args: readonly string[],
  options: RestartSessionOptions,
): Promise<CommandResult> {
  const selector = recipe.tmux.socketSelector;
  const selectorArgs = selector.startsWith('path:')
    ? ['-S', selector.slice('path:'.length)]
    : ['-L', selector.slice('name:'.length)];
  return await runCommand('tmux', [...selectorArgs, ...args], options);
}

async function readRemainOnExit(
  recipe: ManagedRestartRecipeV1,
  options: RestartSessionOptions,
  expected?: RestartJournalV1['pane'] | PaneState,
): Promise<{ explicit: boolean; value?: string } | null> {
  const effective = await runTmux(
    recipe,
    ['show-options', '-p', '-v', '-A', '-t', tmuxTarget(recipe, expected), 'remain-on-exit'],
    options,
  );
  if (effective.exitCode !== 0) return null;
  const explicit = await runTmux(
    recipe,
    ['show-options', '-p', '-v', '-t', tmuxTarget(recipe, expected), 'remain-on-exit'],
    options,
  );
  const explicitValue = explicit.stdout.trim();
  return explicit.exitCode === 0 && (explicitValue === 'on' || explicitValue === 'off')
    ? { explicit: true, value: explicitValue }
    : { explicit: false };
}
async function setRemainOnExit(
  recipe: ManagedRestartRecipeV1,
  value: string,
  options: RestartSessionOptions,
  expected?: RestartJournalV1['pane'] | PaneState,
): Promise<boolean> {
  return (
    (
      await runTmux(
        recipe,
        ['set-option', '-p', '-t', tmuxTarget(recipe, expected), 'remain-on-exit', value],
        options,
      )
    ).exitCode === 0
  );
}
async function restoreRemainOnExit(
  recipe: ManagedRestartRecipeV1,
  previous: { explicit: boolean; value?: string },
  options: RestartSessionOptions,
  expected?: RestartJournalV1['pane'] | PaneState,
): Promise<void> {
  const restored = await runTmux(
    recipe,
    previous.explicit
      ? [
          'set-option',
          '-p',
          '-t',
          tmuxTarget(recipe, expected),
          'remain-on-exit',
          previous.value ?? 'off',
        ]
      : ['set-option', '-p', '-u', '-t', tmuxTarget(recipe, expected), 'remain-on-exit'],
    options,
  );
  if (restored.exitCode !== 0) throw new Error('remain-on-exit-restore-failed');
}

async function cleanupPreparingRestart(
  journal: RestartJournalV1,
  options: RestartSessionOptions,
  directory: string,
  knownRecipe?: ManagedRestartRecipeV1,
): Promise<void> {
  if (journal.previousRemainOnExit !== undefined) {
    const recipe = knownRecipe ?? (await readRestartRecipe(journal.runtimeId, directory));
    if (recipe === null) throw new Error('remain-on-exit-restore-unavailable');
    await restoreRemainOnExit(recipe, journal.previousRemainOnExit, options, journal.pane);
  }
  await removeRestartJournal(journal.runtimeId, directory);
}
async function waitForPaneDead(
  recipe: ManagedRestartRecipeV1,
  ms: number,
  options: RestartSessionOptions,
  expected?: RestartJournalV1['pane'] | PaneState,
): Promise<boolean> {
  const deadline = Math.min(
    Date.now() + ms,
    options.operationDeadlineAt ?? Number.POSITIVE_INFINITY,
  );
  while (Date.now() < deadline) {
    const pane = await inspectPane(recipe, options, expected);
    if (pane?.dead === true && paneMatches(pane, recipe, expected)) return true;
    await sleep(options, POLL_MS);
  }
  return false;
}

async function inspectGeneration(
  pid: number,
  marker: string,
  options: RestartSessionOptions,
): Promise<GenerationInspection> {
  let observed: string | null;
  try {
    observed = await withOperationDeadline(
      (options.readPidStartedAt ?? readPidStartedAt)(pid),
      options,
    );
  } catch {
    return 'unverified';
  }
  if (observed !== null) return observed === marker ? 'matches' : 'reused';

  try {
    return (options.probePidExists ?? checkPidExists)(pid).exists ? 'unverified' : 'missing';
  } catch {
    return 'unverified';
  }
}
function isGenerationGone(inspection: GenerationInspection): boolean {
  return inspection === 'missing' || inspection === 'reused';
}
async function signalExactGeneration(
  pid: number,
  marker: string,
  signal: NodeJS.Signals,
  options: RestartSessionOptions,
): Promise<SignalResult> {
  const inspection = await inspectGeneration(pid, marker, options);
  if (isGenerationGone(inspection)) return 'gone';
  if (inspection === 'unverified') return 'unverified';
  try {
    (options.signal ?? process.kill.bind(process))(pid, signal);
    return 'sent';
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH' ? 'gone' : 'failed';
  }
}
async function waitForGenerationExit(
  pid: number,
  marker: string,
  ms: number,
  options: RestartSessionOptions,
): Promise<GenerationExitState> {
  const deadline = Math.min(
    Date.now() + ms,
    options.operationDeadlineAt ?? Number.POSITIVE_INFINITY,
  );
  let lastInspection: GenerationInspection = 'matches';
  while (Date.now() < deadline) {
    lastInspection = await inspectGeneration(pid, marker, options);
    if (isGenerationGone(lastInspection)) return 'gone';
    await sleep(options, POLL_MS);
  }
  lastInspection = await inspectGeneration(pid, marker, options);
  if (isGenerationGone(lastInspection)) return 'gone';
  return lastInspection === 'unverified' ? 'unverified' : 'alive';
}
async function inspectDescendantPids(
  rootPid: number,
  options: RestartSessionOptions,
): Promise<number[]> {
  return await readDescendantPids(rootPid, async () => {
    const output = await runCommand('ps', ['-axo', 'pid=,ppid='], options);
    return { stdout: output.stdout, exitCode: output.exitCode };
  });
}

async function readSessionHeader(path: string): Promise<{ id: string; cwd: string } | null> {
  try {
    const handle = await open(path, 'r');
    try {
      const buffer = Buffer.alloc(64 * 1024);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      const first = buffer.subarray(0, bytesRead).toString('utf8').split('\n')[0];
      const parsed = JSON.parse(first ?? '') as unknown;
      return isRecord(parsed) &&
        typeof parsed['id'] === 'string' &&
        typeof parsed['cwd'] === 'string'
        ? { id: parsed['id'], cwd: parsed['cwd'] }
        : null;
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}
async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch {
    return null;
  }
}
async function isCurrentUserFile(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    return info.isFile() && (typeof process.getuid !== 'function' || info.uid === process.getuid());
  } catch {
    return false;
  }
}
interface RuntimeLockOwner {
  operationId: string;
  generation: string;
  pid: number;
  osProcessStartedAt: string;
}

interface RuntimeLock {
  owner: RuntimeLockOwner | null;
  legacyOwnerless: boolean;
  device: number;
  inode: number;
}

async function readRuntimeLock(path: string): Promise<RuntimeLock | null> {
  try {
    const info = await stat(path);
    if (
      (typeof process.getuid === 'function' && info.uid !== process.getuid()) ||
      (info.mode & 0o077) !== 0
    )
      return null;
    const legacyOwnerless = info.isDirectory();
    if (!info.isFile() && !legacyOwnerless) return null;
    const candidate = await readJson(legacyOwnerless ? join(path, 'owner.json') : path);
    return {
      owner: normalizeRuntimeLockOwner(candidate),
      legacyOwnerless: legacyOwnerless && candidate === null,
      device: info.dev,
      inode: info.ino,
    };
  } catch {
    return null;
  }
}
function normalizeRuntimeLockOwner(candidate: unknown): RuntimeLockOwner | null {
  return isRecord(candidate) &&
    typeof candidate['operationId'] === 'string' &&
    typeof candidate['generation'] === 'string' &&
    typeof candidate['pid'] === 'number' &&
    Number.isInteger(candidate['pid']) &&
    candidate['pid'] > 0 &&
    typeof candidate['osProcessStartedAt'] === 'string' &&
    Number.isFinite(Date.parse(candidate['osProcessStartedAt']))
    ? (candidate as unknown as RuntimeLockOwner)
    : null;
}
const LEGAL_RESTART_TRANSITIONS: Record<RestartJournalState, readonly RestartJournalState[]> = {
  preparing: ['term-sent'],
  'term-sent': ['kill-sent', 'stopped', 'stop-failed', 'stopped-not-restarted'],
  'kill-sent': ['stopped', 'stop-failed', 'stopped-not-restarted'],
  stopped: ['spawn-requested', 'stopped-not-restarted', 'outcome-unknown'],
  'spawn-requested': ['observing', 'stopped-not-restarted', 'outcome-unknown'],
  observing: ['restarted', 'stopped-not-restarted', 'outcome-unknown'],
  restarted: [],
  'stop-failed': [],
  'stopped-not-restarted': ['spawn-requested', 'outcome-unknown'],
  'outcome-unknown': ['restarted', 'stopped-not-restarted'],
};

async function transition(
  journal: RestartJournalV1,
  state: RestartJournalState,
  directory: string,
): Promise<RestartJournalV1> {
  assertLegalTransition(journal.state, state);
  const next = { ...journal, state, updatedAt: new Date().toISOString() } as RestartJournalV1;
  delete (next as { messageCode?: RestartReasonCode }).messageCode;
  await writeRestartJournal(next, directory);
  return next;
}
async function terminalTransition(
  journal: RestartJournalV1,
  state: RestartJournalState,
  code: RestartReasonCode,
  directory: string,
): Promise<RestartJournalV1> {
  assertLegalTransition(journal.state, state);
  const next = {
    ...journal,
    state,
    messageCode: code,
    updatedAt: new Date().toISOString(),
  } as RestartJournalV1;
  await writeRestartJournal(next, directory);
  return next;
}

function assertLegalTransition(from: RestartJournalState, to: RestartJournalState): void {
  if (!LEGAL_RESTART_TRANSITIONS[from].includes(to))
    throw new Error(`Illegal restart journal transition: ${from} -> ${to}`);
}

function isUnresolved(state: RestartJournalState): boolean {
  return state !== 'restarted' && state !== 'stop-failed';
}

async function acquireRuntimeLock(
  request: RestartSessionRequest,
  directory: string,
  options: RestartSessionOptions,
): Promise<
  | {
      ok: true;
      coordinator: RestartJournalV1['coordinator'];
      release: () => Promise<void>;
    }
  | { ok: false }
> {
  const path = getRestartLockPath(request.runtimeId, directory);
  const coordinatorPid = options.currentPid ?? process.pid;
  const coordinatorStartedAt = await withOperationDeadline(
    (options.readPidStartedAt ?? readPidStartedAt)(coordinatorPid),
    options,
  );
  if (coordinatorStartedAt === null) throw new Error('restart-coordinator-generation-unavailable');
  const coordinator = { pid: coordinatorPid, osProcessStartedAt: coordinatorStartedAt };
  const owner: RuntimeLockOwner = {
    operationId: request.operationId,
    generation: request.generation,
    ...coordinator,
  };
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const candidatePath = `${path}.${coordinator.pid}.${randomUUID()}.candidate`;
    try {
      await writePrivateJson(candidatePath, owner);
      await link(candidatePath, path);
      return {
        ok: true,
        coordinator,
        release: async () => {
          const held = await readRuntimeLock(path);
          if (held !== null && held.owner !== null && lockOwnersEqual(held.owner, owner))
            await rm(path, { force: true });
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const held = await readRuntimeLock(path);
      if (held === null) return { ok: false };
      if (held.owner !== null) {
        const ownerGeneration = await inspectGeneration(
          held.owner.pid,
          held.owner.osProcessStartedAt,
          options,
        );
        if (!isGenerationGone(ownerGeneration)) return { ok: false };
      } else if (!held.legacyOwnerless) {
        return { ok: false };
      }
      if (!(await canReclaimRuntimeLock(request, held.owner, directory, options)))
        return { ok: false };
      if (!(await removeReclaimableRuntimeLock(path, held))) return { ok: false };
    } finally {
      await rm(candidatePath, { force: true }).catch(() => undefined);
    }
  }
  return { ok: false };
}
async function removeReclaimableRuntimeLock(path: string, expected: RuntimeLock): Promise<boolean> {
  if (expected.legacyOwnerless) return await removeReclaimableLegacyLock(path, expected);

  const witnessPath = `${path}.${process.pid}.${randomUUID()}.reclaim`;
  try {
    await link(path, witnessPath);
    const [current, witness] = await Promise.all([readRuntimeLock(path), stat(witnessPath)]);
    if (
      current === null ||
      current.device !== expected.device ||
      current.inode !== expected.inode ||
      current.owner === null ||
      expected.owner === null ||
      !lockOwnersEqual(current.owner, expected.owner) ||
      witness.dev !== expected.device ||
      witness.ino !== expected.inode ||
      witness.nlink !== 2
    )
      return false;
    await rm(path, { force: true });
    return true;
  } catch {
    return false;
  } finally {
    await rm(witnessPath, { force: true }).catch(() => undefined);
  }
}

async function removeReclaimableLegacyLock(path: string, expected: RuntimeLock): Promise<boolean> {
  const claimPath = join(path, '.reclaim');
  let claim: Awaited<ReturnType<typeof open>> | undefined;
  try {
    claim = await open(claimPath, 'wx', 0o600);
    const current = await stat(path);
    if (current.dev !== expected.device || current.ino !== expected.inode) return false;
    await claim.close();
    claim = undefined;
    await rm(path, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  } finally {
    await claim?.close().catch(() => undefined);
    await rm(claimPath, { force: true }).catch(() => undefined);
  }
}

function lockOwnersEqual(left: RuntimeLockOwner, right: RuntimeLockOwner): boolean {
  return (
    left.operationId === right.operationId &&
    left.generation === right.generation &&
    left.pid === right.pid &&
    left.osProcessStartedAt === right.osProcessStartedAt
  );
}
async function canReclaimRuntimeLock(
  request: RestartSessionRequest,
  owner: RuntimeLockOwner | null,
  directory: string,
  options: RestartSessionOptions,
): Promise<boolean> {
  const journalPath = getRestartJournalPath(request.runtimeId, directory);
  const journalExists = await stat(journalPath).then(
    () => true,
    () => false,
  );
  const journal = await readRestartJournal(request.runtimeId, directory);
  if (journalExists && journal === null) return false;
  if (journal !== null) {
    if (
      owner !== null &&
      (journal.operationId !== owner.operationId ||
        journal.generation !== owner.generation ||
        journal.coordinator.pid !== owner.pid ||
        journal.coordinator.osProcessStartedAt !== owner.osProcessStartedAt)
    )
      return false;
    return (
      (await inspectGeneration(journal.oldPid, journal.oldOsProcessStartedAt, options)) !==
      'unverified'
    );
  }

  const recipe = await readRestartRecipe(request.runtimeId, directory);
  if (recipe?.binding === undefined) return true;
  return (
    (await inspectGeneration(recipe.binding.pid, recipe.binding.osProcessStartedAt, options)) !==
    'unverified'
  );
}
function terminalResult(journal: RestartJournalV1): RestartSessionResult | null {
  if (journal.state === 'restarted' || journal.state === 'stop-failed') {
    return result(
      journal.state,
      journal,
      journal.messageCode ?? 'operation-state-unknown',
      journal.state !== 'restarted',
    );
  }
  return null;
}
function result(
  status: RestartSessionStatus,
  request: Pick<RestartSessionRequest, 'operationId'>,
  reason: RestartReasonCode,
  retryable: boolean,
): RestartSessionResult {
  const messages: Record<RestartSessionStatus, string> = {
    restarted: 'Session restarted.',
    'not-eligible': 'Restart is unavailable for this session.',
    'stale-generation': 'The session changed; refresh before restarting.',
    'already-in-progress': 'A restart is already in progress.',
    'stop-failed': 'Session Deck could not prove the old process stopped.',
    'stopped-not-restarted':
      'The old process stopped, but Pi did not restart. Retry this operation.',
    'outcome-unknown':
      'Session Deck could not confirm the restart outcome. Reconcile before retrying.',
  };
  return {
    ok: status === 'restarted',
    status,
    operationId: request.operationId,
    reason,
    retryable,
    message: messages[status],
  };
}
function now(options: RestartSessionOptions): string {
  return (options.now ?? (() => new Date()))().toISOString();
}
function sleep(options: RestartSessionOptions, ms: number): Promise<void> {
  return options.sleep?.(ms) ?? new Promise((resolve) => setTimeout(resolve, ms));
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function runCommand(
  file: string,
  args: readonly string[],
  options: RestartSessionOptions,
): Promise<CommandResult> {
  const remaining = (options.operationDeadlineAt ?? Number.POSITIVE_INFINITY) - Date.now();
  if (remaining <= 0) throw new Error('restart-operation-deadline');

  const controller = new AbortController();
  const operation = (options.exec ?? defaultExec)(file, args, { signal: controller.signal });
  if (!Number.isFinite(remaining)) return await operation;

  let timer: ReturnType<typeof setTimeout> | undefined;
  let deadlineExpired = false;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          deadlineExpired = true;
          reject(new Error('restart-operation-deadline'));
        }, remaining);
        timer.unref?.();
      }),
    ]);
  } catch (error) {
    if (deadlineExpired) {
      controller.abort();
      await operation.catch(() => undefined);
    }
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function withOperationDeadline<T>(
  operation: Promise<T>,
  options: RestartSessionOptions,
): Promise<T> {
  const remaining = (options.operationDeadlineAt ?? Number.POSITIVE_INFINITY) - Date.now();
  if (remaining <= 0) throw new Error('restart-operation-deadline');
  if (!Number.isFinite(remaining)) return await operation;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('restart-operation-deadline')), remaining);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

const defaultExec: RestartExec = async (file, args, options) => {
  try {
    const value = await execFile(file, [...args], {
      encoding: 'utf8',
      timeout: 10_000,
      signal: options.signal,
    });
    return { stdout: value.stdout, stderr: value.stderr, exitCode: 0 };
  } catch (error) {
    const child = error as NodeJS.ErrnoException & {
      stdout?: string;
      stderr?: string;
      code?: number | string;
    };
    return {
      stdout: child.stdout ?? '',
      stderr: child.stderr ?? '',
      exitCode: typeof child.code === 'number' ? child.code : 1,
    };
  }
};

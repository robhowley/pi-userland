import type { SessionTerminalMetadata } from '../identity/types.js';
import { readPidStartedAt } from '../presence/pid.js';
import { readDescendantPids } from './process.js';
import { createRestartGeneration, readRestartJournal, readRestartRecipe } from './store.js';
import type { RestartEligibility, RestartJournalState, RestartReasonCode } from './types.js';

const UNRESOLVED_STATES = new Set<RestartJournalState>([
  'preparing',
  'term-sent',
  'kill-sent',
  'stopped',
  'stopped-not-restarted',
  'spawn-requested',
  'observing',
  'outcome-unknown',
]);

export interface RestartEligibilityObservation {
  pid: number;
  sessionId: string | null;
  sessionFile: string | null;
  cwd: string | null;
  terminal?: SessionTerminalMetadata;
  processPid?: number;
}

export async function readRestartEligibility(
  runtimeId: string,
  options: {
    directory?: string;
    observed?: RestartEligibilityObservation;
    hostingRuntimeId?: string;
    readPidStartedAt?: typeof readPidStartedAt;
    readDescendantPids?: typeof readDescendantPids;
  } = {},
): Promise<RestartEligibility> {
  if (runtimeId === options.hostingRuntimeId)
    return { available: false, reason: 'hosting-runtime' };

  const recipe = await readRestartRecipe(runtimeId, options.directory);
  if (recipe === null) {
    const journal = await readRestartJournal(runtimeId, options.directory);
    return journal === null
      ? { available: false, reason: 'managed-recipe-unavailable' }
      : { available: false, reason: journal.messageCode ?? 'operation-state-unknown' };
  }
  if (recipe.binding === undefined) return { available: false, reason: 'recipe-not-bound' };

  const journal = await readRestartJournal(runtimeId, options.directory);
  if (journal !== null && UNRESOLVED_STATES.has(journal.state)) {
    return {
      available: true,
      generation: journal.generation,
      operation: {
        operationId: journal.operationId,
        status: journal.state,
        retryable: true,
      },
    };
  }

  const observed = options.observed;
  const terminal = observed?.terminal;
  if (
    observed === undefined ||
    observed.pid !== recipe.binding.pid ||
    observed.sessionId !== recipe.binding.sessionId ||
    observed.sessionFile !== recipe.binding.sessionFile ||
    observed.cwd !== recipe.cwd ||
    observed.processPid !== recipe.binding.pid ||
    terminal?.kind !== 'tmux' ||
    terminal.sessionName !== recipe.tmux.sessionName ||
    terminal.windowIndex !== recipe.tmux.windowIndex ||
    terminal.paneIndex !== recipe.tmux.paneIndex ||
    terminal.panePid !== recipe.binding.pid ||
    !tmuxSocketMatches(recipe.tmux.socketSelector, terminal.socketPath)
  )
    return { available: false, reason: 'identity-mismatch' };

  const observedStartedAt = await (options.readPidStartedAt ?? readPidStartedAt)(
    recipe.binding.pid,
  );
  if (observedStartedAt !== recipe.binding.osProcessStartedAt)
    return { available: false, reason: 'generation-changed' };

  if ((await (options.readDescendantPids ?? readDescendantPids)(recipe.binding.pid)).length > 0)
    return { available: false, reason: 'unsafe-descendants' };

  return {
    available: true,
    generation: createRestartGeneration(
      runtimeId,
      recipe.binding.pid,
      recipe.binding.osProcessStartedAt,
    ),
  };
}

export function restartUnavailableMessage(reason: RestartReasonCode): string {
  switch (reason) {
    case 'managed-recipe-unavailable':
      return 'Restart is available only for new Session Deck-managed tmux sessions.';
    case 'recipe-not-bound':
      return 'Restart will become available after Session Deck verifies this managed session.';
    case 'hosting-runtime':
      return 'Restarting the Session Deck TUI hosting runtime is unavailable.';
    case 'unsafe-descendants':
      return 'Restart is unavailable while Pi owns child processes.';
    case 'operation-in-progress':
      return 'A restart is already in progress.';
    case 'generation-changed':
      return 'The selected session generation changed; refresh before restarting.';
    default:
      return 'Session Deck could not safely verify this session for restart.';
  }
}

function tmuxSocketMatches(selector: string, socketPath: string | undefined): boolean {
  if (socketPath === undefined) return false;
  return selector.startsWith('path:')
    ? selector.slice('path:'.length) === socketPath
    : socketPath.endsWith(`/${selector.slice('name:'.length)}`);
}

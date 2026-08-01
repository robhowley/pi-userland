import { readPidStartedAt } from '../presence/pid.js';
import type { SessionIdentityRecord } from '../identity/types.js';
import type { CreateWorktreeLaunchAgentDir } from '../worktree/types.js';
import { readRestartRecipe, writeRestartRecipe } from './store.js';
import type { ManagedRestartRecipeV1 } from './types.js';

const SESSION_DIR_ENV = 'PI_CODING_AGENT_SESSION_DIR';

export interface CreateManagedRestartRecipeInput {
  runtimeId: string;
  piExecutable: string;
  effectivePath: string;
  agentDir: CreateWorktreeLaunchAgentDir;
  env: NodeJS.ProcessEnv;
  cwd: string;
  sessionName: string;
  socketSelector?: string;
  now?: () => Date;
}

export function createManagedRestartRecipe(
  input: CreateManagedRestartRecipeInput,
): ManagedRestartRecipeV1 {
  const ambientAgentDir = trimNonEmpty(input.env['PI_CODING_AGENT_DIR']);
  const explicitSessionDir = trimNonEmpty(input.env[SESSION_DIR_ENV]);
  return {
    schemaVersion: 1,
    runtimeId: input.runtimeId,
    launch: {
      piExecutable: input.piExecutable,
      effectivePath: input.effectivePath,
      agentDir:
        input.agentDir.mode === 'custom'
          ? { mode: 'custom', path: input.agentDir.customDir }
          : input.agentDir.mode === 'default'
            ? { mode: 'default' }
            : {
                mode: 'ambient',
                ...(ambientAgentDir === undefined ? {} : { path: ambientAgentDir }),
              },
      ...(explicitSessionDir === undefined
        ? {}
        : { sessionDir: { mode: 'explicit' as const, path: explicitSessionDir } }),
    },
    cwd: input.cwd,
    tmux: {
      socketSelector: input.socketSelector ?? resolveTmuxSocketSelector(input.env),
      sessionName: input.sessionName,
      windowIndex: 0,
      paneIndex: 0,
    },
    createdAt: (input.now ?? (() => new Date()))().toISOString(),
  };
}

export interface BindManagedRestartRecipeOptions {
  directory?: string;
  readRecipe?: typeof readRestartRecipe;
  writeRecipe?: typeof writeRestartRecipe;
  readPidStartedAt?: typeof readPidStartedAt;
  now?: () => Date;
}

export async function bindManagedRestartRecipe(
  identity: SessionIdentityRecord,
  options: BindManagedRestartRecipeOptions = {},
): Promise<boolean> {
  const recipe = await (options.readRecipe ?? readRestartRecipe)(
    identity.runtimeId,
    ...(options.directory === undefined ? [] : [options.directory]),
  );
  if (recipe === null || identity.sessionId === null || identity.sessionFile === null) return false;
  const terminal = identity.terminal;
  const processMetadata = identity.runtimeSignals?.process;
  if (
    terminal?.kind !== 'tmux' ||
    processMetadata === undefined ||
    terminal.sessionName !== recipe.tmux.sessionName ||
    !tmuxSocketMatches(recipe.tmux.socketSelector, terminal.socketPath) ||
    terminal.windowIndex !== recipe.tmux.windowIndex ||
    terminal.paneIndex !== recipe.tmux.paneIndex ||
    terminal.panePid !== processMetadata.pid ||
    identity.cwd !== recipe.cwd ||
    identity.sessionHeader?.id !== identity.sessionId ||
    identity.sessionHeader.cwd !== recipe.cwd
  )
    return false;

  const osProcessStartedAt = await (options.readPidStartedAt ?? readPidStartedAt)(
    processMetadata.pid,
  );
  if (osProcessStartedAt === null) return false;
  const oldBinding = recipe.binding;
  if (
    oldBinding !== undefined &&
    (oldBinding.pid !== processMetadata.pid ||
      oldBinding.osProcessStartedAt !== osProcessStartedAt) &&
    (oldBinding.sessionId !== identity.sessionId || oldBinding.sessionFile !== identity.sessionFile)
  )
    return false;

  await (options.writeRecipe ?? writeRestartRecipe)(
    {
      ...recipe,
      binding: {
        sessionId: identity.sessionId,
        sessionFile: identity.sessionFile,
        pid: processMetadata.pid,
        osProcessStartedAt,
        boundAt: (options.now ?? (() => new Date()))().toISOString(),
      },
    },
    ...(options.directory === undefined ? [] : [options.directory]),
  );
  return true;
}

export function resolveTmuxSocketSelector(env: NodeJS.ProcessEnv): string {
  const socketPath = trimNonEmpty(env['TMUX']?.split(',')[0]);
  return socketPath === undefined ? 'name:default' : `path:${socketPath}`;
}

function tmuxSocketMatches(selector: string, socketPath: string | undefined): boolean {
  if (socketPath === undefined) return false;
  return selector.startsWith('path:')
    ? selector.slice('path:'.length) === socketPath
    : socketPath.endsWith(`/${selector.slice('name:'.length)}`);
}

function trimNonEmpty(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

import { constants, createReadStream } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import {
  launchCmuxWorkspace,
  preflightCmux,
  type CmuxLaunchRecipe,
  type CmuxOptions,
} from './cmux.js';
import type { ProcessRunner } from './process.js';
import {
  applyWorktreePlan,
  planWorktree,
  type WorktreeOptions,
  type WorktreeSuccess,
} from './worktree.js';

export const JUNCTION_COMMAND = 'junction';
const FORK_SUBCOMMAND = 'fork';
const BRANCH_FLAG = '--branch';
const FRESH_USAGE = `Usage: /junction ${BRANCH_FLAG} <name>`;
const FORK_USAGE = `Usage: /junction ${FORK_SUBCOMMAND} ${BRANCH_FLAG} <name>`;
const USAGE = FRESH_USAGE;

export interface JunctionSessionContext {
  waitForIdle: () => Promise<void>;
  sessionManager: {
    getSessionFile: () => string | undefined;
  };
}

export interface JunctionCommandOptions {
  runner?: ProcessRunner;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  lockRoot?: string;
  timeoutMs?: number;
  plan?: typeof planWorktree;
  preflight?: typeof preflightCmux;
  apply?: typeof applyWorktreePlan;
  launch?: typeof launchCmuxWorkspace;
}

export type JunctionResult =
  | {
      ok: true;
      status: 'created-and-launched' | 'reused-and-launched';
      worktree: WorktreeSuccess;
    }
  | { ok: false; status: 'invalid-command'; message: string }
  | { ok: false; status: 'source-session-failed'; message: string }
  | { ok: false; status: 'planning-failed'; message: string }
  | { ok: false; status: 'preflight-failed'; message: string }
  | { ok: false; status: 'worktree-failed'; message: string }
  | {
      ok: false;
      status: 'partial-launch-failed';
      branch: string;
      path: string;
      worktreeRetained: true;
      message: string;
    }
  | {
      ok: false;
      status: 'partial-launch-unknown';
      branch: string;
      path: string;
      worktreeRetained: true;
      retrySafe: false;
      message: string;
    };

export function registerJunctionCommand(
  pi: Pick<ExtensionAPI, 'registerCommand'>,
  options: JunctionCommandOptions = {},
): void {
  pi.registerCommand(JUNCTION_COMMAND, {
    description: 'Create or reuse a branch worktree and launch Pi in a new cmux workspace',
    getArgumentCompletions: getJunctionArgumentCompletions,
    handler: async (args, ctx) => {
      const result = await runJunctionCommand(args, ctx.cwd, options, ctx);
      notifyResult(ctx, result);
    },
  });
}

const BRANCH_COMPLETION = {
  value: BRANCH_FLAG,
  label: BRANCH_FLAG,
  description: 'Branch to create or reuse',
};
const FORK_COMPLETION = {
  value: FORK_SUBCOMMAND,
  label: FORK_SUBCOMMAND,
  description: 'Fork the current persisted session',
};

export function getJunctionArgumentCompletions(prefix: string) {
  const trimmedPrefix = prefix.trimStart();
  if (trimmedPrefix.length === 0) {
    return [FORK_COMPLETION, BRANCH_COMPLETION];
  }

  const forkArguments = trimmedPrefix.match(/^fork(?:\s+)(.*)$/u);
  if (forkArguments !== null) {
    const branchPrefix = forkArguments[1] ?? '';
    if (branchPrefix.trim().length === 0) {
      return [BRANCH_COMPLETION];
    }
    return BRANCH_FLAG.startsWith(branchPrefix) && !/\s$/u.test(branchPrefix)
      ? [BRANCH_COMPLETION]
      : null;
  }
  if (FORK_SUBCOMMAND.startsWith(trimmedPrefix) && !trimmedPrefix.includes(' ')) {
    return [FORK_COMPLETION];
  }
  if (BRANCH_FLAG.startsWith(trimmedPrefix) && !/\s$/u.test(trimmedPrefix)) {
    return [BRANCH_COMPLETION];
  }
  return null;
}

export type JunctionParseResult =
  | { ok: true; branch: string }
  | { ok: true; mode: 'fork'; branch: string }
  | { ok: false; message: string };

export function parseJunctionArgs(args: string): JunctionParseResult {
  const tokens = args.trim().length === 0 ? [] : args.trim().split(/\s+/u);
  if (tokens[0] === FORK_SUBCOMMAND) {
    return parseBranchArgs(tokens.slice(1), FORK_USAGE, true);
  }
  return parseBranchArgs(tokens, USAGE, false);
}

function parseBranchArgs(tokens: string[], usage: string, fork: boolean): JunctionParseResult {
  if (tokens.length === 0 || (tokens.length === 1 && tokens[0] === BRANCH_FLAG)) {
    return { ok: false, message: `Branch name is required. ${usage}` };
  }
  if (tokens[0] !== BRANCH_FLAG) {
    return { ok: false, message: `Only ${BRANCH_FLAG} <name> is supported. ${usage}` };
  }
  if (
    tokens.length !== 2 ||
    tokens[1] === undefined ||
    tokens[1].trim().length === 0 ||
    tokens[1].startsWith('--')
  ) {
    return { ok: false, message: `Expected exactly one branch and no other arguments. ${usage}` };
  }
  return fork
    ? { ok: true, mode: 'fork', branch: tokens[1].trim() }
    : { ok: true, branch: tokens[1].trim() };
}

export async function runJunctionCommand(
  args: string,
  cwd: string,
  options: JunctionCommandOptions = {},
  context?: JunctionSessionContext,
): Promise<JunctionResult> {
  const parsed = parseJunctionArgs(args);
  if (!parsed.ok) {
    return { ok: false, status: 'invalid-command', message: parsed.message };
  }

  const mode = 'mode' in parsed ? parsed.mode : 'fresh';
  let recipe: CmuxLaunchRecipe | undefined;
  if (mode === 'fork') {
    const source = await captureForkSourceSession(context);
    if (!source.ok) {
      return source;
    }
    recipe = { mode, sourceSessionFile: source.path };
  }

  const worktreeOptions = buildWorktreeOptions(options);
  const plan = await (options.plan ?? planWorktree)(cwd, parsed.branch, worktreeOptions);
  if (!plan.ok) {
    return { ok: false, status: 'planning-failed', message: plan.message };
  }

  const cmuxOptions = buildCmuxOptions(options);
  const preflight = await (options.preflight ?? preflightCmux)(cwd, cmuxOptions);
  if (!preflight.ok) {
    return { ok: false, status: 'preflight-failed', message: preflight.message };
  }

  const worktree = await (options.apply ?? applyWorktreePlan)(plan, worktreeOptions);
  if (!worktree.ok) {
    return { ok: false, status: 'worktree-failed', message: worktree.message };
  }

  const launch =
    recipe === undefined
      ? await (options.launch ?? launchCmuxWorkspace)(worktree.branch, worktree.path, cmuxOptions)
      : await (options.launch ?? launchCmuxWorkspace)(
          worktree.branch,
          worktree.path,
          cmuxOptions,
          recipe,
        );
  if (!launch.ok) {
    if (launch.reason === 'launch-unknown') {
      return {
        ok: false,
        status: 'partial-launch-unknown',
        branch: worktree.branch,
        path: worktree.path,
        worktreeRetained: true,
        retrySafe: false,
        message: `Worktree retained, but cmux launch status is unknown: ${launch.message}\nBranch: ${worktree.branch}\nPath: ${worktree.path}\nThe workspace may exist; inspect cmux before taking further action.`,
      };
    }
    const retry =
      mode === 'fork'
        ? `/junction ${FORK_SUBCOMMAND} ${BRANCH_FLAG} ${worktree.branch}`
        : `/junction ${BRANCH_FLAG} ${worktree.branch}`;
    return {
      ok: false,
      status: 'partial-launch-failed',
      branch: worktree.branch,
      path: worktree.path,
      worktreeRetained: true,
      message: `Worktree retained after cmux launch failed: ${launch.message}\nBranch: ${worktree.branch}\nPath: ${worktree.path}\nRetry: ${retry}`,
    };
  }

  return {
    ok: true,
    status: worktree.status === 'created' ? 'created-and-launched' : 'reused-and-launched',
    worktree,
  };
}

interface ForkSourceSuccess {
  ok: true;
  path: string;
}

interface ForkSourceFailure {
  ok: false;
  status: 'source-session-failed';
  message: string;
}

export async function captureForkSourceSession(
  context: JunctionSessionContext | undefined,
): Promise<ForkSourceSuccess | ForkSourceFailure> {
  if (context === undefined) {
    return sourceFailure('Fork mode requires an active Pi session; no worktree was created.');
  }

  try {
    await context.waitForIdle();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return sourceFailure(
      `Could not settle the current session before forking: ${detail}; no worktree was created.`,
    );
  }

  let sessionFile: string | undefined;
  try {
    sessionFile = context.sessionManager.getSessionFile();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return sourceFailure(
      `Could not read the current session file: ${detail}; no worktree was created.`,
    );
  }

  const normalizedPath = typeof sessionFile === 'string' ? sessionFile.trim() : '';
  if (normalizedPath.length === 0) {
    return sourceFailure(
      'Fork mode requires a persisted session; the current session is ephemeral or unavailable, so no worktree was created.',
    );
  }
  if (!isAbsolute(normalizedPath)) {
    return sourceFailure(
      `Fork mode requires an absolute persisted session file: ${normalizedPath}; no worktree was created.`,
    );
  }

  const absolutePath = resolve(normalizedPath);
  try {
    const details = await stat(absolutePath);
    if (!details.isFile()) {
      throw new Error('path is not a regular file');
    }
    await access(absolutePath, constants.R_OK);
  } catch {
    return sourceFailure(
      `Fork source session is absent or unreadable: ${absolutePath}; no worktree was created.`,
    );
  }

  let firstLine = '';
  const source = createReadStream(absolutePath, { encoding: 'utf8' });
  try {
    for await (const chunk of source) {
      const newline = chunk.indexOf('\n');
      firstLine += newline === -1 ? chunk : chunk.slice(0, newline);
      if (newline !== -1) break;
    }
  } catch {
    return sourceFailure(
      `Fork source session is absent or unreadable: ${absolutePath}; no worktree was created.`,
    );
  } finally {
    source.destroy();
  }

  let firstRecord: unknown;
  try {
    firstRecord = JSON.parse(firstLine);
  } catch {
    return sourceFailure(
      `Fork source session does not begin with a valid session record: ${absolutePath}; no worktree was created.`,
    );
  }
  if (
    typeof firstRecord !== 'object' ||
    firstRecord === null ||
    !('type' in firstRecord) ||
    firstRecord.type !== 'session'
  ) {
    return sourceFailure(
      `Fork source session does not begin with a valid session record: ${absolutePath}; no worktree was created.`,
    );
  }

  return { ok: true, path: absolutePath };
}

function sourceFailure(message: string): ForkSourceFailure {
  return { ok: false, status: 'source-session-failed', message };
}

function notifyResult(ctx: ExtensionCommandContext, result: JunctionResult): void {
  if (!result.ok) {
    ctx.ui.notify(result.message, 'error');
    return;
  }

  const verb = result.worktree.status === 'created' ? 'Created' : 'Reused';
  const warning =
    result.worktree.warning === undefined ? '' : `\nWarning: ${result.worktree.warning}`;
  ctx.ui.notify(
    `${verb} worktree and launched cmux workspace.\nBranch: ${result.worktree.branch}\nPath: ${result.worktree.path}${warning}`,
    'info',
  );
}

function buildWorktreeOptions(options: JunctionCommandOptions): WorktreeOptions {
  return {
    ...(options.runner === undefined ? {} : { runner: options.runner }),
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.homeDir === undefined ? {} : { homeDir: options.homeDir }),
    ...(options.lockRoot === undefined ? {} : { lockRoot: options.lockRoot }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  };
}

function buildCmuxOptions(options: JunctionCommandOptions): CmuxOptions {
  return {
    ...(options.runner === undefined ? {} : { runner: options.runner }),
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  };
}

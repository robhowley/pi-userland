import { constants, createReadStream } from 'node:fs';
import { access, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
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
  proveRetainedWorktree,
  type ExplicitWorktreePlan,
  type WorktreeOptions,
  type WorktreeSuccess,
} from './worktree.js';

export const JUNCTION_COMMAND = 'junction';
const FORK_SUBCOMMAND = 'fork';
const BRANCH_FLAG = '--branch';
const FROM_FLAG = '--from';
const FRESH_USAGE = `Usage: /junction ${BRANCH_FLAG} <name> [${FROM_FLAG} <commit-ish>]`;
const FORK_USAGE = `Usage: /junction ${FORK_SUBCOMMAND} ${BRANCH_FLAG} <name> [${FROM_FLAG} <commit-ish>]`;
const USAGE = FRESH_USAGE;

export interface JunctionSessionContext {
  waitForIdle: () => Promise<void>;
  sessionManager: {
    getSessionFile: () => string | undefined;
  };
}

type JunctionPlanner = (
  cwd: string,
  branch: string,
  options: WorktreeOptions,
  from?: string,
) => ReturnType<typeof planWorktree>;

/**
 * Read-only proof that an explicit create retained the exact path, branch, and pinned commit.
 * The core worktree implementation owns the Git checks; the command only gates retry guidance.
 */
export type RetainedWorktreeProof = (
  plan: ExplicitWorktreePlan,
  options: WorktreeOptions,
) => Promise<boolean>;

export interface JunctionCommandOptions {
  runner?: ProcessRunner;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  lockRoot?: string;
  timeoutMs?: number;
  plan?: JunctionPlanner;
  preflight?: typeof preflightCmux;
  apply?: typeof applyWorktreePlan;
  launch?: typeof launchCmuxWorkspace;
  proveRetained?: RetainedWorktreeProof;
}

export type JunctionResult =
  | {
      ok: true;
      status: 'created-and-launched' | 'reused-and-launched';
      worktree: WorktreeSuccess;
      launchCwd: string;
      launchCwdWarning?: string;
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
      launchCwd: string;
      worktreeRetained: true;
      message: string;
    }
  | {
      ok: false;
      status: 'partial-launch-unknown';
      branch: string;
      path: string;
      launchCwd: string;
      worktreeRetained: true;
      retrySafe: false;
      message: string;
    };

export function registerJunctionCommand(
  pi: Pick<ExtensionAPI, 'registerCommand'>,
  options: JunctionCommandOptions = {},
): void {
  pi.registerCommand(JUNCTION_COMMAND, {
    description:
      'Create or reuse a branch worktree from a committed Git ref and launch Pi in a new cmux workspace',
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
const FROM_COMPLETION = {
  value: FROM_FLAG,
  label: FROM_FLAG,
  description: 'Create from a committed Git ref; working-tree changes are not copied',
};
const HEAD_COMPLETION = {
  value: 'HEAD',
  label: 'HEAD',
  description:
    'Current committed commit; staged, unstaged, untracked, and ignored changes are not copied',
};

export function getJunctionArgumentCompletions(prefix: string) {
  const input = prefix.trimStart();
  if (input.length === 0) {
    return [FORK_COMPLETION, BRANCH_COMPLETION];
  }

  const trailingWhitespace = /\s$/u.test(input);
  const tokens = input.trim().split(/\s+/u);
  const mode = tokens[0] === FORK_SUBCOMMAND ? 'fork' : 'fresh';
  const argumentsStart = mode === 'fork' ? 1 : 0;

  if (mode === 'fresh' && tokens[0] !== undefined && !tokens[0].startsWith('-')) {
    return FORK_SUBCOMMAND.startsWith(tokens[0]) && !trailingWhitespace && tokens.length === 1
      ? [FORK_COMPLETION]
      : null;
  }
  if (mode === 'fork' && tokens.length === 1 && trailingWhitespace) {
    return [BRANCH_COMPLETION];
  }
  if (mode === 'fork' && tokens.length === 1) {
    return FORK_SUBCOMMAND.startsWith(tokens[0] ?? '') ? [FORK_COMPLETION] : null;
  }

  const argumentTokens = tokens.slice(argumentsStart);
  if (argumentTokens.length === 0) {
    return [BRANCH_COMPLETION];
  }
  if (argumentTokens.length === 1) {
    const token = argumentTokens[0] ?? '';
    return BRANCH_FLAG.startsWith(token) && !trailingWhitespace ? [BRANCH_COMPLETION] : null;
  }
  if (argumentTokens[0] !== BRANCH_FLAG) {
    return null;
  }
  if (argumentTokens[1]?.startsWith('--')) {
    return null;
  }
  if (argumentTokens.length === 2) {
    if (trailingWhitespace) {
      return [FROM_COMPLETION];
    }
    return null;
  }

  const afterBranch = argumentTokens.slice(2);
  if (afterBranch.length === 1) {
    const token = afterBranch[0] ?? '';
    if (token === FROM_FLAG && trailingWhitespace) {
      return [HEAD_COMPLETION];
    }
    return FROM_FLAG.startsWith(token) && !trailingWhitespace ? [FROM_COMPLETION] : null;
  }
  if (afterBranch[0] !== FROM_FLAG) {
    return null;
  }
  if (afterBranch.length === 2 && !trailingWhitespace) {
    return 'HEAD'.startsWith(afterBranch[1] ?? '') ? [HEAD_COMPLETION] : null;
  }
  return null;
}

export type JunctionParseResult =
  | { ok: true; branch: string; from?: string }
  | { ok: true; mode: 'fork'; branch: string; from?: string }
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

  const branch = tokens[1];
  if (branch === undefined || branch.length === 0 || branch.startsWith('--')) {
    return { ok: false, message: `Expected exactly one branch and no other arguments. ${usage}` };
  }
  if (tokens.length === 2) {
    return fork ? { ok: true, mode: 'fork', branch } : { ok: true, branch };
  }
  if (tokens[2] !== FROM_FLAG) {
    return { ok: false, message: `Expected ${FROM_FLAG} after the branch. ${usage}` };
  }

  const from = tokens[3];
  if (from === undefined || from.length === 0 || from.startsWith('--') || tokens.length !== 4) {
    return { ok: false, message: `Expected one commit-ish after ${FROM_FLAG}. ${usage}` };
  }
  return fork ? { ok: true, mode: 'fork', branch, from } : { ok: true, branch, from };
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
  const plan = await (options.plan ?? planWorktree)(
    cwd,
    parsed.branch,
    worktreeOptions,
    parsed.from,
  );
  if (!plan.ok) {
    return { ok: false, status: 'planning-failed', message: plan.message };
  }

  let sourceCwd: string;
  try {
    sourceCwd = await realpath(cwd);
  } catch {
    return {
      ok: false,
      status: 'planning-failed',
      message: 'Could not resolve the current working directory; no worktree was created.',
    };
  }
  if (!isContained(plan.repository.topLevel, sourceCwd)) {
    return {
      ok: false,
      status: 'planning-failed',
      message: 'Current cwd resolves outside the repository; no worktree was created.',
    };
  }
  const relativeCwd = relative(plan.repository.topLevel, sourceCwd);

  const cmuxOptions = buildCmuxOptions(options);
  const preflight = await (options.preflight ?? preflightCmux)(cwd, cmuxOptions);
  if (!preflight.ok) {
    return { ok: false, status: 'preflight-failed', message: preflight.message };
  }

  const worktree = await (options.apply ?? applyWorktreePlan)(plan, worktreeOptions);
  if (!worktree.ok) {
    return { ok: false, status: 'worktree-failed', message: worktree.message };
  }

  const launchCwd = await chooseLaunchCwd(worktree.path, relativeCwd);
  const launch =
    recipe === undefined
      ? await (options.launch ?? launchCmuxWorkspace)(worktree.branch, launchCwd.path, cmuxOptions)
      : await (options.launch ?? launchCmuxWorkspace)(
          worktree.branch,
          launchCwd.path,
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
        launchCwd: launchCwd.path,
        worktreeRetained: true,
        retrySafe: false,
        message: `Worktree retained, but cmux launch status is unknown: ${launch.message}\nBranch: ${worktree.branch}\nPath: ${worktree.path}\nLaunch cwd: ${launchCwd.path}\nThe workspace may exist; inspect cmux before taking further action.`,
      };
    }

    const retry =
      mode === 'fork'
        ? `/junction ${FORK_SUBCOMMAND} ${BRANCH_FLAG} ${worktree.branch}`
        : `/junction ${BRANCH_FLAG} ${worktree.branch}`;
    if (plan.kind === 'create-explicit') {
      const proofPassed = await proveExplicitRetention(
        plan,
        worktreeOptions,
        options.proveRetained,
      );
      const sourceLine = `\nFrom: ${plan.baseRef} -> ${plan.baseSha}`;
      const guidance = proofPassed
        ? `Retry: ${retry}`
        : 'Retained-state proof did not pass; inspect Git state before retrying.';
      return {
        ok: false,
        status: 'partial-launch-failed',
        branch: worktree.branch,
        path: worktree.path,
        launchCwd: launchCwd.path,
        worktreeRetained: true,
        message: `Worktree retained after cmux launch failed: ${launch.message}\nBranch: ${worktree.branch}\nPath: ${worktree.path}\nLaunch cwd: ${launchCwd.path}${sourceLine}\n${guidance}`,
      };
    }

    return {
      ok: false,
      status: 'partial-launch-failed',
      branch: worktree.branch,
      path: worktree.path,
      launchCwd: launchCwd.path,
      worktreeRetained: true,
      message: `Worktree retained after cmux launch failed: ${launch.message}\nBranch: ${worktree.branch}\nPath: ${worktree.path}\nLaunch cwd: ${launchCwd.path}\nRetry: ${retry}`,
    };
  }

  return {
    ok: true,
    status: worktree.status === 'created' ? 'created-and-launched' : 'reused-and-launched',
    worktree,
    launchCwd: launchCwd.path,
    ...(launchCwd.fellBack
      ? {
          launchCwdWarning: `Could not preserve "${relativeCwd}" because it is absent or unsafe in the target worktree; launched at the worktree root.`,
        }
      : {}),
  };
}

async function proveExplicitRetention(
  plan: ExplicitWorktreePlan,
  options: WorktreeOptions,
  injected: RetainedWorktreeProof | undefined,
): Promise<boolean> {
  try {
    return (await (injected ?? proveRetainedWorktree)(plan, options)) === true;
  } catch {
    return false;
  }
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
  const warnings = [result.worktree.warning, result.launchCwdWarning]
    .filter((warning) => warning !== undefined)
    .map((warning) => `\nWarning: ${warning}`)
    .join('');
  const from =
    result.worktree.kind === 'create-explicit'
      ? `\nFrom: ${result.worktree.baseRef} -> ${result.worktree.baseSha}`
      : '';
  ctx.ui.notify(
    `${verb} worktree and launched cmux workspace.\nBranch: ${result.worktree.branch}\nPath: ${result.worktree.path}\nLaunch cwd: ${result.launchCwd}${from}${warnings}`,
    'info',
  );
}

function isContained(root: string, candidate: string): boolean {
  const remainder = relative(root, candidate);
  return (
    remainder === '' ||
    (!isAbsolute(remainder) && remainder !== '..' && !remainder.startsWith(`..${sep}`))
  );
}

async function chooseLaunchCwd(
  worktreeRoot: string,
  relativeCwd: string,
): Promise<{ path: string; fellBack: boolean }> {
  if (relativeCwd === '') {
    return { path: worktreeRoot, fellBack: false };
  }

  try {
    const worktreeDirectory = await realpath(worktreeRoot);
    const launchDirectory = await realpath(resolve(worktreeDirectory, relativeCwd));
    if (
      !isContained(worktreeDirectory, launchDirectory) ||
      !(await stat(launchDirectory)).isDirectory()
    ) {
      return { path: worktreeRoot, fellBack: true };
    }
    return { path: launchDirectory, fellBack: false };
  } catch {
    return { path: worktreeRoot, fellBack: true };
  }
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

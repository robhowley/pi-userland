import { constants, createReadStream } from 'node:fs';
import { access, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import {
  launchCmuxTab,
  launchCmuxWorkspace,
  preflightCmux,
  preflightCmuxTab,
  type CmuxLaunchRecipe,
  type CmuxOptions,
} from './cmux.js';
import { installJunctionBoard, type BoardInstallResult } from './board-install.js';
import type { ProcessRunner } from './process.js';
import {
  applyWorktreePlan,
  planCheckoutWorktree,
  planWorktree,
  proveRetainedWorktree,
  type ExplicitWorktreePlan,
  type WorktreeOptions,
  type WorktreeSuccess,
} from './worktree.js';

export const JUNCTION_COMMAND = 'junction';
const FORK_SUBCOMMAND = 'fork';
const CHECKOUT_SUBCOMMAND = 'checkout';
const BRANCH_FLAG = '--branch';
const FROM_FLAG = '--from';
const TAB_FLAG = '--tab';
const FRESH_USAGE = `Usage: /junction ${BRANCH_FLAG} <name> [${FROM_FLAG} <commit-ish>] [${TAB_FLAG}]`;
const FORK_USAGE = `Usage: /junction ${FORK_SUBCOMMAND} ${BRANCH_FLAG} <name> [${FROM_FLAG} <commit-ish>] [${TAB_FLAG}]`;
const CHECKOUT_USAGE = `Usage: /junction ${CHECKOUT_SUBCOMMAND} ${BRANCH_FLAG} <local-branch> [${TAB_FLAG}]`;
const JUNCTION_HELP = [
  'Junction commands:',
  '  /junction [help] — show this command reference',
  `  /junction ${BRANCH_FLAG} <name> [${TAB_FLAG}] — create a new worktree from the default base or reuse a matching worktree; launch a fresh Pi session`,
  `  /junction ${BRANCH_FLAG} <name> ${FROM_FLAG} <commit-ish> [${TAB_FLAG}] — create a new worktree from the specified commit-ish (never reuse); launch a fresh Pi session`,
  `  /junction ${FORK_SUBCOMMAND} ${BRANCH_FLAG} <name> [${TAB_FLAG}] — wait for the current persisted session to idle, then create a new worktree from the default base or reuse a matching worktree; fork the conversation`,
  `  /junction ${FORK_SUBCOMMAND} ${BRANCH_FLAG} <name> ${FROM_FLAG} <commit-ish> [${TAB_FLAG}] — wait for the current persisted session to idle, then create a new worktree from the specified commit-ish (never reuse); fork the conversation`,
  `  /junction ${CHECKOUT_SUBCOMMAND} ${BRANCH_FLAG} <local-branch> [${TAB_FLAG}] — open an existing local branch in its worktree; launch a fresh Pi session`,
  '  /junction board install — install or safely update the packaged sidebar file; does not select it or enable publication',
  '  For worktree commands, append `--tab` to launch Pi in a new unfocused tab in this workspace instead of a new cmux workspace.',
].join('\n');

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

type JunctionCheckoutPlanner = (
  cwd: string,
  branch: string,
  options: WorktreeOptions,
) => ReturnType<typeof planCheckoutWorktree>;

/**
 * Read-only proof that an explicit create retained the exact path, branch, and pinned commit.
 * The core worktree implementation owns the Git checks; the command only gates retry guidance.
 */
export type RetainedWorktreeProof = (
  plan: ExplicitWorktreePlan,
  options: WorktreeOptions,
) => Promise<boolean>;

export interface JunctionCommandOptions {
  installBoard?: typeof installJunctionBoard;
  runner?: ProcessRunner;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  lockRoot?: string;
  timeoutMs?: number;
  plan?: JunctionPlanner;
  planCheckout?: JunctionCheckoutPlanner;
  preflight?: typeof preflightCmux;
  preflightTab?: typeof preflightCmuxTab;
  apply?: typeof applyWorktreePlan;
  launch?: typeof launchCmuxWorkspace;
  launchTab?: typeof launchCmuxTab;
  proveRetained?: RetainedWorktreeProof;
}

export type JunctionResult =
  | BoardInstallResult
  | {
      ok: true;
      status: 'created-and-launched' | 'reused-and-launched';
      worktree: WorktreeSuccess;
      launchCwd: string;
      launchCwdWarning?: string;
      tab?: { surfaceRef: string };
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
      tab?: never;
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
      tab?: never;
      message: string;
    }
  | {
      ok: false;
      status: 'partial-launch-failed';
      branch: string;
      path: string;
      launchCwd: string;
      worktreeRetained: true;
      tab: { mutation: 'none' };
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
      tab: { mutation: 'may-exist' };
      message: string;
    }
  | {
      ok: false;
      status: 'partial-launch-failed';
      branch: string;
      path: string;
      launchCwd: string;
      worktreeRetained: true;
      retrySafe: false;
      tab: { mutation: 'exists'; surfaceRef: string };
      message: string;
    };

export function registerJunctionCommand(
  pi: Pick<ExtensionAPI, 'registerCommand'>,
  options: JunctionCommandOptions = {},
): void {
  pi.registerCommand(JUNCTION_COMMAND, {
    description:
      'Create a branch worktree or check out an existing local branch, then launch Pi in a new cmux workspace; a final --tab launches Pi in a new unfocused tab in this workspace instead; board install installs or safely updates the packaged sidebar file',
    getArgumentCompletions: getJunctionArgumentCompletions,
    handler: async (args, ctx) => {
      const trimmedArgs = args.trim();
      if (trimmedArgs.length === 0 || trimmedArgs === 'help') {
        ctx.ui.notify(JUNCTION_HELP, 'info');
        return;
      }

      const result = await runJunctionCommand(args, ctx.cwd, options, ctx);
      notifyResult(ctx, result);
    },
  });
}

const BOARD_COMPLETION = {
  value: 'board',
  label: 'board',
  description: 'Install the packaged sidebar file',
};
const BOARD_INSTALL_COMPLETION = {
  value: 'board install',
  label: 'install',
  description: 'Install or safely update the packaged sidebar file',
};
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
const CHECKOUT_COMPLETION = {
  value: CHECKOUT_SUBCOMMAND,
  label: CHECKOUT_SUBCOMMAND,
  description: 'Open an existing local branch in a fresh session',
};
const FROM_COMPLETION = {
  value: FROM_FLAG,
  label: FROM_FLAG,
  description: 'Create from a committed Git ref; working-tree changes are not copied',
};
const TAB_COMPLETION = {
  value: TAB_FLAG,
  label: TAB_FLAG,
  description: 'Launch Pi in a new unfocused tab in this workspace',
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
    return [FORK_COMPLETION, CHECKOUT_COMPLETION, BRANCH_COMPLETION, BOARD_COMPLETION];
  }

  const trailingWhitespace = /\s$/u.test(input);
  const tokens = input.trim().split(/\s+/u);
  const firstToken = tokens[0] ?? '';

  if (firstToken === 'board') {
    if (tokens.length === 1)
      return trailingWhitespace ? [BOARD_INSTALL_COMPLETION] : [BOARD_COMPLETION];
    return tokens.length === 2 && !trailingWhitespace && 'install'.startsWith(tokens[1] ?? '')
      ? [BOARD_INSTALL_COMPLETION]
      : null;
  }

  if (firstToken === CHECKOUT_SUBCOMMAND) {
    if (tokens.length === 1) {
      return trailingWhitespace ? [BRANCH_COMPLETION] : [CHECKOUT_COMPLETION];
    }
    if (tokens.length === 2) {
      const token = tokens[1] ?? '';
      return BRANCH_FLAG.startsWith(token) && !trailingWhitespace ? [BRANCH_COMPLETION] : null;
    }
    if (tokens.length === 3 && tokens[1] === BRANCH_FLAG) {
      const branch = tokens[2] ?? '';
      if (branch.length === 0 || branch.startsWith('-')) return null;
      return trailingWhitespace ? [TAB_COMPLETION] : null;
    }
    if (tokens.length === 4 && tokens[1] === BRANCH_FLAG) {
      const branch = tokens[2] ?? '';
      const token = tokens[3] ?? '';
      if (branch.length === 0 || branch.startsWith('-')) return null;
      return TAB_FLAG.startsWith(token) && !trailingWhitespace ? [TAB_COMPLETION] : null;
    }
    return null;
  }

  const mode = firstToken === FORK_SUBCOMMAND ? 'fork' : 'fresh';
  const argumentsStart = mode === 'fork' ? 1 : 0;

  if (mode === 'fresh' && !firstToken.startsWith('-')) {
    if (trailingWhitespace || tokens.length !== 1) return null;
    if ('board'.startsWith(firstToken)) return [BOARD_COMPLETION];
    if (FORK_SUBCOMMAND.startsWith(firstToken)) return [FORK_COMPLETION];
    if (CHECKOUT_SUBCOMMAND.startsWith(firstToken)) return [CHECKOUT_COMPLETION];
    return null;
  }
  if (mode === 'fork' && tokens.length === 1 && trailingWhitespace) {
    return [BRANCH_COMPLETION];
  }
  if (mode === 'fork' && tokens.length === 1) {
    return FORK_SUBCOMMAND.startsWith(firstToken) ? [FORK_COMPLETION] : null;
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
      return [FROM_COMPLETION, TAB_COMPLETION];
    }
    return null;
  }

  const afterBranch = argumentTokens.slice(2);
  if (afterBranch.length === 1) {
    const token = afterBranch[0] ?? '';
    if (token === FROM_FLAG && trailingWhitespace) {
      return [HEAD_COMPLETION];
    }
    if (FROM_FLAG.startsWith(token) && !trailingWhitespace) return [FROM_COMPLETION];
    return TAB_FLAG.startsWith(token) && !trailingWhitespace ? [TAB_COMPLETION] : null;
  }
  if (afterBranch[0] !== FROM_FLAG) {
    return null;
  }
  if (afterBranch.length === 2) {
    const value = afterBranch[1] ?? '';
    if (value.length === 0 || value.startsWith('--')) return null;
    if (trailingWhitespace) return [TAB_COMPLETION];
    return 'HEAD'.startsWith(value) ? [HEAD_COMPLETION] : null;
  }
  if (afterBranch.length === 3 && !trailingWhitespace) {
    const value = afterBranch[1] ?? '';
    const token = afterBranch[2] ?? '';
    if (value.length === 0 || value.startsWith('--')) return null;
    return TAB_FLAG.startsWith(token) ? [TAB_COMPLETION] : null;
  }
  return null;
}

export type JunctionParseResult =
  | { ok: true; mode: 'board-install' }
  | { ok: true; mode: 'fresh'; branch: string; from?: string; tab?: true }
  | { ok: true; mode: 'fork'; branch: string; from?: string; tab?: true }
  | { ok: true; mode: 'checkout'; branch: string; tab?: true }
  | { ok: false; message: string };

export function parseJunctionArgs(args: string): JunctionParseResult {
  const tokens = args.trim().length === 0 ? [] : args.trim().split(/\s+/u);
  if (tokens[0] === 'board') {
    return tokens.length === 2 && tokens[1] === 'install'
      ? { ok: true, mode: 'board-install' }
      : { ok: false, message: 'Usage: /junction board install' };
  }
  if (tokens[0] === FORK_SUBCOMMAND) {
    return parseBranchArgs(tokens.slice(1), FORK_USAGE, 'fork');
  }
  if (tokens[0] === CHECKOUT_SUBCOMMAND) {
    return parseCheckoutArgs(tokens.slice(1));
  }
  return parseBranchArgs(tokens, FRESH_USAGE, 'fresh');
}

function parseCheckoutArgs(tokens: string[]): JunctionParseResult {
  const hasTab = tokens.at(-1) === TAB_FLAG;
  const grammarTokens = hasTab ? tokens.slice(0, -1) : tokens;
  if (
    grammarTokens.length === 0 ||
    (grammarTokens.length === 1 && grammarTokens[0] === BRANCH_FLAG)
  ) {
    return { ok: false, message: `Local branch name is required. ${CHECKOUT_USAGE}` };
  }
  const branch = grammarTokens[1];
  if (
    grammarTokens.length !== 2 ||
    grammarTokens[0] !== BRANCH_FLAG ||
    branch === undefined ||
    branch.length === 0 ||
    branch.startsWith('-')
  ) {
    return {
      ok: false,
      message: `Expected exactly ${BRANCH_FLAG} <local-branch>. ${CHECKOUT_USAGE}`,
    };
  }
  return { ok: true, mode: 'checkout', branch, ...(hasTab ? { tab: true } : {}) };
}

function parseBranchArgs(
  tokens: string[],
  usage: string,
  mode: 'fresh' | 'fork',
): JunctionParseResult {
  const hasTab = tokens.at(-1) === TAB_FLAG;
  const grammarTokens = hasTab ? tokens.slice(0, -1) : tokens;
  if (
    grammarTokens.length === 0 ||
    (grammarTokens.length === 1 && grammarTokens[0] === BRANCH_FLAG)
  ) {
    return { ok: false, message: `Branch name is required. ${usage}` };
  }
  if (grammarTokens[0] !== BRANCH_FLAG) {
    return { ok: false, message: `Only ${BRANCH_FLAG} <name> is supported. ${usage}` };
  }

  const branch = grammarTokens[1];
  if (branch === undefined || branch.length === 0 || branch.startsWith('--')) {
    return { ok: false, message: `Expected exactly one branch and no other arguments. ${usage}` };
  }
  if (grammarTokens.length === 2) {
    return { ok: true, mode, branch, ...(hasTab ? { tab: true } : {}) };
  }
  if (grammarTokens[2] !== FROM_FLAG) {
    return { ok: false, message: `Expected ${FROM_FLAG} after the branch. ${usage}` };
  }

  const from = grammarTokens[3];
  if (
    from === undefined ||
    from.length === 0 ||
    from.startsWith('--') ||
    grammarTokens.length !== 4
  ) {
    return { ok: false, message: `Expected one commit-ish after ${FROM_FLAG}. ${usage}` };
  }
  return { ok: true, mode, branch, from, ...(hasTab ? { tab: true } : {}) };
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

  if (parsed.mode === 'board-install') {
    return (options.installBoard ?? installJunctionBoard)(
      options.homeDir === undefined ? {} : { homeDir: options.homeDir },
    );
  }

  const { mode } = parsed;
  let recipe: CmuxLaunchRecipe | undefined;
  if (mode === 'fork') {
    const source = await captureForkSourceSession(context);
    if (!source.ok) {
      return source;
    }
    recipe = { mode, sourceSessionFile: source.path };
  }

  const worktreeOptions = buildWorktreeOptions(options);
  const plan =
    mode === 'checkout'
      ? await (options.planCheckout ?? planCheckoutWorktree)(cwd, parsed.branch, worktreeOptions)
      : await (options.plan ?? planWorktree)(cwd, parsed.branch, worktreeOptions, parsed.from);
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
  const tabPreflight =
    parsed.tab === true
      ? await (options.preflightTab ?? preflightCmuxTab)(cwd, cmuxOptions)
      : undefined;
  if (tabPreflight !== undefined && !tabPreflight.ok) {
    return { ok: false, status: 'preflight-failed', message: tabPreflight.message };
  }
  if (parsed.tab !== true) {
    const preflight = await (options.preflight ?? preflightCmux)(cwd, cmuxOptions);
    if (!preflight.ok) {
      return { ok: false, status: 'preflight-failed', message: preflight.message };
    }
  }

  const worktree = await (options.apply ?? applyWorktreePlan)(plan, worktreeOptions);
  if (!worktree.ok) {
    return { ok: false, status: 'worktree-failed', message: worktree.message };
  }

  const launchCwd = await chooseLaunchCwd(worktree.path, relativeCwd);
  if (tabPreflight?.ok === true) {
    const tabRecipe: CmuxLaunchRecipe = recipe ?? { mode: 'fresh' };
    const tabLaunch = await (options.launchTab ?? launchCmuxTab)(
      launchCwd.path,
      tabPreflight.caller,
      cmuxOptions,
      tabRecipe,
    );
    if (!tabLaunch.ok) {
      const retry =
        mode === 'fork'
          ? `/junction ${FORK_SUBCOMMAND} ${BRANCH_FLAG} ${worktree.branch} ${TAB_FLAG}`
          : mode === 'checkout'
            ? `/junction ${CHECKOUT_SUBCOMMAND} ${BRANCH_FLAG} ${worktree.branch} ${TAB_FLAG}`
            : `/junction ${BRANCH_FLAG} ${worktree.branch} ${TAB_FLAG}`;
      const retained = `Branch: ${worktree.branch}\nPath: ${worktree.path}\nLaunch cwd: ${launchCwd.path}`;

      if (tabLaunch.mutation === 'may-exist') {
        return {
          ok: false,
          status: 'partial-launch-unknown',
          branch: worktree.branch,
          path: worktree.path,
          launchCwd: launchCwd.path,
          worktreeRetained: true,
          retrySafe: false,
          tab: { mutation: 'may-exist' },
          message: `Worktree retained, but cmux tab creation is unknown: ${tabLaunch.message}\n${retained}\nTarget: window ${tabLaunch.target.windowId}, workspace ${tabLaunch.target.workspaceId}, pane ${tabLaunch.target.paneId}.\nNo automatic retry or cleanup was attempted.`,
        };
      }
      if (tabLaunch.mutation === 'exists') {
        return {
          ok: false,
          status: 'partial-launch-failed',
          branch: worktree.branch,
          path: worktree.path,
          launchCwd: launchCwd.path,
          worktreeRetained: true,
          retrySafe: false,
          tab: { mutation: 'exists', surfaceRef: tabLaunch.surfaceRef },
          message: `Worktree retained after Pi launch submission failed for cmux tab ${tabLaunch.surfaceRef}: ${tabLaunch.message}\n${retained}\nThe tab may be blank or partially launched. No automatic retry or cleanup was attempted.`,
        };
      }

      const sourceLine =
        plan.kind === 'create-explicit' ? `\nFrom: ${plan.baseRef} -> ${plan.baseSha}` : '';
      const proofPassed =
        plan.kind !== 'create-explicit' ||
        (await proveExplicitRetention(plan, worktreeOptions, options.proveRetained));
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
        tab: { mutation: 'none' },
        message: `Worktree retained after cmux tab launch failed before creation: ${tabLaunch.message}\n${retained}${sourceLine}\nNo tab was created or launch command submitted.\n${guidance}`,
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
      tab: { surfaceRef: tabLaunch.surfaceRef },
    };
  }

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
        : mode === 'checkout'
          ? `/junction ${CHECKOUT_SUBCOMMAND} ${BRANCH_FLAG} ${worktree.branch}`
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

  if (
    result.status === 'board-installed' ||
    result.status === 'board-updated' ||
    result.status === 'board-current'
  ) {
    const verb =
      result.status === 'board-installed'
        ? 'Installed'
        : result.status === 'board-updated'
          ? 'Updated'
          : 'Already current';
    ctx.ui.notify(
      `${verb}: ${result.path}${result.status === 'board-current' && result.warning ? `\nWarning: ${result.warning}` : ''}`,
      'info',
    );
    return;
  }

  const verb = result.worktree.status === 'created' ? 'Created' : 'Reused';
  const warnings = [
    result.worktree.kind === 'checkout' ? undefined : result.worktree.warning,
    result.launchCwdWarning,
  ]
    .filter((warning) => warning !== undefined)
    .map((warning) => `\nWarning: ${warning}`)
    .join('');
  const from =
    result.worktree.kind === 'create-explicit'
      ? `\nFrom: ${result.worktree.baseRef} -> ${result.worktree.baseSha}`
      : '';
  const launchSummary =
    result.tab === undefined
      ? `${verb} worktree and launched cmux workspace.`
      : `${verb} worktree and cmux accepted one Pi launch command for tab ${result.tab.surfaceRef}; Pi startup is not confirmed.`;
  ctx.ui.notify(
    `${launchSummary}\nBranch: ${result.worktree.branch}\nPath: ${result.worktree.path}\nLaunch cwd: ${result.launchCwd}${from}${warnings}`,
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

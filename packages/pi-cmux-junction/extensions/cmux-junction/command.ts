import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { launchCmuxWorkspace, preflightCmux, type CmuxOptions } from './cmux.js';
import type { ProcessRunner } from './process.js';
import {
  applyWorktreePlan,
  planWorktree,
  type WorktreeOptions,
  type WorktreeSuccess,
} from './worktree.js';

export const JUNCTION_COMMAND = 'junction';
const USAGE = 'Usage: /junction --branch <name>';

export interface JunctionCommandOptions {
  runner?: ProcessRunner;
  env?: NodeJS.ProcessEnv;
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
    };

export function registerJunctionCommand(
  pi: Pick<ExtensionAPI, 'registerCommand'>,
  options: JunctionCommandOptions = {},
): void {
  pi.registerCommand(JUNCTION_COMMAND, {
    description: 'Create or reuse a branch worktree and launch Pi in a new cmux workspace',
    handler: async (args, ctx) => {
      const result = await runJunctionCommand(args, ctx.cwd, options);
      notifyResult(ctx, result);
    },
  });
}

export function parseJunctionArgs(
  args: string,
): { ok: true; branch: string } | { ok: false; message: string } {
  const tokens = args.trim().length === 0 ? [] : args.trim().split(/\s+/u);
  if (tokens.length === 0 || (tokens.length === 1 && tokens[0] === '--branch')) {
    return { ok: false, message: `Branch name is required. ${USAGE}` };
  }
  if (tokens[0] !== '--branch') {
    return { ok: false, message: `Only --branch <name> is supported. ${USAGE}` };
  }
  if (
    tokens.length !== 2 ||
    tokens[1] === undefined ||
    tokens[1].trim().length === 0 ||
    tokens[1].startsWith('--')
  ) {
    return { ok: false, message: `Expected exactly one branch and no other arguments. ${USAGE}` };
  }
  return { ok: true, branch: tokens[1].trim() };
}

export async function runJunctionCommand(
  args: string,
  cwd: string,
  options: JunctionCommandOptions = {},
): Promise<JunctionResult> {
  const parsed = parseJunctionArgs(args);
  if (!parsed.ok) {
    return { ok: false, status: 'invalid-command', message: parsed.message };
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

  const launch = await (options.launch ?? launchCmuxWorkspace)(
    worktree.branch,
    worktree.path,
    cmuxOptions,
  );
  if (!launch.ok) {
    const retry = `/junction --branch ${worktree.branch}`;
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

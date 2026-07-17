import {
  LAUNCH_CONTEXT_SCOPE_WARNING,
  PI_CODING_AGENT_DIR_ENV,
  buildLaunchAgentDirEnvPlan,
  getPiDefaultAgentDirDisplay,
  normalizeLaunchAgentDirSelection,
  shortenHomeDir,
} from './agent-dir.js';
import { defaultWorktreeExecFile, resolveDefaultBaseRef, type WorktreeExecFile } from './git.js';
import { resolveRepoIntent, type ResolveRepoIntentOptions } from './repo-intent.js';
import type {
  WorktreeBasePreviewRequest,
  WorktreeBasePreviewResult,
  WorktreeLaunchContextPreviewRequest,
  WorktreeLaunchContextPreviewResult,
  WorktreeLaunchContextProvenance,
} from './types.js';

export type ResolveWorktreeBasePreviewOptions = ResolveRepoIntentOptions;

export interface ResolveWorktreeLaunchContextPreviewOptions {
  execFile?: WorktreeExecFile;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
}

export async function resolveWorktreeBasePreview(
  request: WorktreeBasePreviewRequest,
  options: ResolveWorktreeBasePreviewOptions = {},
): Promise<WorktreeBasePreviewResult> {
  const repo = await resolveRepoIntent(request.repoIntent, options);
  if (!repo.ok) {
    return {
      ok: false,
      status: 'failed',
      reason: repo.reason === 'ambiguous' ? 'repo-intent-ambiguous' : 'repo-intent-unresolved',
      message: repo.message,
      recoverable: true,
    };
  }

  const baseResolution = await resolveDefaultBaseRef(repo.repo.primaryWorktreePath, options);
  return {
    ok: true,
    status: 'resolved',
    baseRef: baseResolution.baseRef,
    ...(baseResolution.warning === undefined ? {} : { warning: baseResolution.warning }),
  };
}

export async function resolveWorktreeLaunchContextPreview(
  request: WorktreeLaunchContextPreviewRequest,
  options: ResolveWorktreeLaunchContextPreviewOptions = {},
): Promise<WorktreeLaunchContextPreviewResult> {
  const normalized = normalizeLaunchAgentDirSelection(request.agentDir, options);
  if (!normalized.ok) {
    return {
      ok: false,
      status: 'failed',
      reason: 'invalid-request',
      message: normalized.message,
      recoverable: true,
    };
  }

  const agentDir = normalized.agentDir;
  const plan = buildLaunchAgentDirEnvPlan(agentDir);
  const warnings = [LAUNCH_CONTEXT_SCOPE_WARNING];
  if (agentDir.mode === 'default') {
    return {
      ok: true,
      status: 'resolved',
      mode: 'default',
      envAction: plan.envAction,
      effectiveDisplay: getPiDefaultAgentDirDisplay(options),
      provenance: 'request',
      warnings,
    };
  }
  if (agentDir.mode === 'custom') {
    return {
      ok: true,
      status: 'resolved',
      mode: 'custom',
      envAction: plan.envAction,
      effectiveDisplay: shortenHomeDir(agentDir.customDir, options),
      provenance: 'request',
      warnings,
    };
  }

  const ambient = await resolveAmbientAgentDir(options);
  return {
    ok: true,
    status: 'resolved',
    mode: 'ambient',
    envAction: plan.envAction,
    effectiveDisplay: ambient.effectiveDisplay,
    provenance: ambient.provenance,
    warnings: [...warnings, ...ambient.warnings],
  };
}

async function resolveAmbientAgentDir(
  options: ResolveWorktreeLaunchContextPreviewOptions,
): Promise<{
  effectiveDisplay: string;
  provenance: WorktreeLaunchContextProvenance;
  warnings: string[];
}> {
  const tmux = await readTmuxServerAgentDir(options);
  if (tmux.status === 'set') {
    return {
      effectiveDisplay: shortenHomeDir(tmux.value, options),
      provenance: 'tmux-server-env',
      warnings: [],
    };
  }
  if (tmux.status === 'unset') {
    return {
      effectiveDisplay: getPiDefaultAgentDirDisplay(options),
      provenance: 'pi-default',
      warnings: [],
    };
  }

  const fallback = getProcessEnvAgentDirPreview(options);
  return {
    ...fallback,
    warnings:
      tmux.status === 'ambiguous'
        ? ['Could not determine tmux server PI_CODING_AGENT_DIR; showing process/default preview.']
        : [],
  };
}

function getProcessEnvAgentDirPreview(options: ResolveWorktreeLaunchContextPreviewOptions): {
  effectiveDisplay: string;
  provenance: WorktreeLaunchContextProvenance;
} {
  const env = options.env ?? process.env;
  const envValue = env[PI_CODING_AGENT_DIR_ENV];
  if (typeof envValue === 'string' && envValue.trim().length > 0) {
    return { effectiveDisplay: shortenHomeDir(envValue, options), provenance: 'process-env' };
  }
  return { effectiveDisplay: getPiDefaultAgentDirDisplay(options), provenance: 'pi-default' };
}

async function readTmuxServerAgentDir(
  options: ResolveWorktreeLaunchContextPreviewOptions,
): Promise<
  | { status: 'set'; value: string }
  | { status: 'unset' }
  | { status: 'no-server' }
  | { status: 'ambiguous' }
> {
  const execFile = options.execFile ?? defaultWorktreeExecFile;
  const result = await execFile('tmux', ['show-environment', '-g', PI_CODING_AGENT_DIR_ENV], {
    env: options.env ?? process.env,
    timeoutMs: 5_000,
  }).catch(() => ({ stdout: '', stderr: '', exitCode: 1 }));

  const output = `${result.stdout}\n${result.stderr}`;
  if (result.exitCode !== 0) {
    if (/no server running|failed to connect/iu.test(output)) {
      return { status: 'no-server' };
    }
    if (/unknown variable|not found|unset/iu.test(output)) {
      return { status: 'unset' };
    }
    return { status: 'ambiguous' };
  }

  const line = result.stdout.trim();
  if (line.length === 0 || line === `-${PI_CODING_AGENT_DIR_ENV}`) {
    return { status: 'unset' };
  }
  const prefix = `${PI_CODING_AGENT_DIR_ENV}=`;
  if (line.startsWith(prefix)) {
    const value = line.slice(prefix.length);
    return value.length === 0 ? { status: 'unset' } : { status: 'set', value };
  }
  return { status: 'ambiguous' };
}

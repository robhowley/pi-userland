import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import { resolveCmuxExecutable } from './cmux-runtime.mjs';
import {
  defaultProcessRunner,
  processError,
  processSucceeded,
  type ProcessResult,
  type ProcessRunner,
} from './process.js';

export interface CmuxOptions {
  runner?: ProcessRunner;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  activeAgentDir?: string;
}

export interface CmuxTarget {
  socketPath: string;
  workspaceId: string;
  surfaceId: string;
}

export type CmuxTargetResolution =
  | ({ ok: true } & CmuxTarget)
  | { ok: false; reason: 'process-failed' | 'invalid-response'; message: string };

export type CmuxLaunchRecipe = { mode: 'fresh' } | { mode: 'fork'; sourceSessionFile: string };

export interface CmuxTabCaller extends CmuxTarget {
  windowId: string;
  paneId: string;
}

export type CmuxTabPreflightResult =
  | { ok: true; caller: CmuxTabCaller }
  | {
      ok: false;
      reason: 'missing-caller' | 'cmux-unavailable' | 'pi-unavailable' | 'caller-unavailable';
      message: string;
    };

export type CmuxTabLaunchResult =
  | { ok: true; mutation: 'exists'; surfaceRef: string; target: CmuxTabCaller }
  | {
      ok: false;
      mutation: 'none';
      reason: 'caller-unavailable' | 'staging-failed' | 'create-not-started';
      message: string;
    }
  | {
      ok: false;
      mutation: 'may-exist';
      reason: 'create-unknown';
      target: CmuxTabCaller;
      message: string;
    }
  | {
      ok: false;
      mutation: 'exists';
      reason: 'send-failed';
      surfaceRef: string;
      target: CmuxTabCaller;
      message: string;
    };

const PI_CODING_AGENT_DIR_ENV = 'PI_CODING_AGENT_DIR';
const SOURCE_SESSION_ENV = 'PI_CMUX_JUNCTION_SOURCE_SESSION';
const FRESH_PI_COMMAND = 'exec pi';
const FORK_PI_COMMAND = 'exec pi --fork "$PI_CMUX_JUNCTION_SOURCE_SESSION"';

export type CmuxPreflightResult =
  | { ok: true }
  | {
      ok: false;
      reason: 'missing-caller' | 'cmux-unavailable' | 'pi-unavailable';
      message: string;
    };

export type CmuxLaunchResult =
  | { ok: true }
  | { ok: false; reason: 'launch-failed' | 'launch-unknown'; message: string };

export async function preflightCmux(
  cwd: string,
  options: CmuxOptions = {},
): Promise<CmuxPreflightResult> {
  const env = options.env ?? process.env;
  if (!env['CMUX_WORKSPACE_ID']?.trim() || !env['CMUX_SURFACE_ID']?.trim()) {
    return {
      ok: false,
      reason: 'missing-caller',
      message:
        'Junction requires nonblank CMUX_WORKSPACE_ID and CMUX_SURFACE_ID; no worktree was created.',
    };
  }

  const cmuxFile = await resolveCmuxExecutable(env);
  const cmux = await run(cmuxFile, ['capabilities'], cwd, env, options);
  if (!processSucceeded(cmux)) {
    return {
      ok: false,
      reason: 'cmux-unavailable',
      message: `Junction requires an available cmux CLI; no worktree was created. ${processError(cmux)}`,
    };
  }

  const pi = await run('which', ['pi'], cwd, env, options);
  if (!processSucceeded(pi)) {
    return {
      ok: false,
      reason: 'pi-unavailable',
      message: 'Junction requires the pi executable on PATH; no worktree was created.',
    };
  }

  return { ok: true };
}

const CMUX_TARGET_RESOLUTION_TIMEOUT_MS = 2_000;
const CMUX_TARGET_RESOLUTION_MAX_BUFFER_BYTES = 64 * 1024;

export async function resolveCmuxTarget(
  cwd: string,
  target: CmuxTarget,
  options: CmuxOptions = {},
): Promise<CmuxTargetResolution> {
  const env = options.env ?? process.env;
  const socketPath = normalizeTargetIdentity(target.socketPath);
  const workspaceId = normalizeTargetIdentity(target.workspaceId);
  const surfaceId = normalizeTargetIdentity(target.surfaceId);
  if (socketPath === null || workspaceId === null || surfaceId === null) {
    return {
      ok: false,
      reason: 'invalid-response',
      message: 'cmux target resolution requires nonblank target identities',
    };
  }

  const cmuxFile = await resolveCmuxExecutable(env);
  const args = [
    '--socket',
    socketPath,
    'rpc',
    'agent.resolve_delivery_target',
    JSON.stringify({ surface_id: surfaceId, workspace_id: workspaceId }),
  ];
  let result: Awaited<ReturnType<ProcessRunner>>;
  try {
    result = await run(
      cmuxFile,
      args,
      cwd,
      env,
      options.timeoutMs === undefined
        ? { ...options, timeoutMs: CMUX_TARGET_RESOLUTION_TIMEOUT_MS }
        : options,
      CMUX_TARGET_RESOLUTION_MAX_BUFFER_BYTES,
    );
  } catch {
    return {
      ok: false,
      reason: 'process-failed',
      message: 'cmux target resolution could not run',
    };
  }
  if (!processSucceeded(result)) {
    return {
      ok: false,
      reason: 'process-failed',
      message: `cmux target resolution failed: ${processError(result)}`,
    };
  }

  const resolved = parseResolvedTarget(result.stdout, surfaceId);
  if (resolved === null) {
    return {
      ok: false,
      reason: 'invalid-response',
      message: 'cmux returned an invalid delivery target',
    };
  }
  return { ok: true, socketPath, ...resolved };
}

export function buildWorkspaceCreateArgs(
  branch: string,
  worktreePath: string,
  activeAgentDir: string,
  recipe: CmuxLaunchRecipe = { mode: 'fresh' },
): string[] {
  const launchArgs = [
    '--env',
    `${PI_CODING_AGENT_DIR_ENV}=${activeAgentDir}`,
    ...(recipe.mode === 'fork'
      ? ['--env', `${SOURCE_SESSION_ENV}=${recipe.sourceSessionFile}`, '--command', FORK_PI_COMMAND]
      : ['--command', FRESH_PI_COMMAND]),
  ];

  return [
    'workspace',
    'create',
    '--name',
    branch,
    '--cwd',
    worktreePath,
    ...launchArgs,
    '--focus',
    'false',
  ];
}

export async function preflightCmuxTab(
  cwd: string,
  options: CmuxOptions = {},
): Promise<CmuxTabPreflightResult> {
  const env = options.env ?? process.env;
  const socketPath = normalizeTargetIdentity(env['CMUX_SOCKET_PATH']);
  const workspaceId = normalizeTargetIdentity(env['CMUX_WORKSPACE_ID']);
  const surfaceId = normalizeTargetIdentity(env['CMUX_SURFACE_ID']);
  if (socketPath === null || workspaceId === null || surfaceId === null) {
    return {
      ok: false,
      reason: 'missing-caller',
      message:
        'Tab launch requires nonblank CMUX_SOCKET_PATH, CMUX_WORKSPACE_ID, and CMUX_SURFACE_ID; no worktree was created.',
    };
  }

  const preflight = await preflightCmux(cwd, options);
  if (!preflight.ok) return preflight;

  const caller = await resolveAndIdentifyCmuxCaller(
    cwd,
    { socketPath, workspaceId, surfaceId },
    options,
  );
  if (caller === null) {
    return {
      ok: false,
      reason: 'caller-unavailable',
      message: 'The invoking cmux terminal could not be identified; no worktree was created.',
    };
  }
  return { ok: true, caller };
}

export async function launchCmuxTab(
  worktreePath: string,
  caller: CmuxTabCaller,
  options: CmuxOptions = {},
  recipe: CmuxLaunchRecipe = { mode: 'fresh' },
): Promise<CmuxTabLaunchResult> {
  const env = options.env ?? process.env;

  let script: StagedTabLaunchScript;
  try {
    const activeAgentDir = options.activeAgentDir ?? resolve(process.cwd(), getAgentDir());
    script = await stageTabLaunchScript(activeAgentDir, recipe);
  } catch {
    return {
      ok: false,
      mutation: 'none',
      reason: 'staging-failed',
      message: 'The private tab launch script could not be staged.',
    };
  }

  let cmuxFile: string;
  try {
    cmuxFile = await resolveCmuxExecutable(env);
  } catch {
    await removeStagedTabLaunchScript(script);
    return {
      ok: false,
      mutation: 'none',
      reason: 'create-not-started',
      message: 'cmux tab creation could not start.',
    };
  }

  const target = await resolveAndIdentifyCmuxCaller(worktreePath, caller, options);
  if (target === null) {
    await removeStagedTabLaunchScript(script);
    return {
      ok: false,
      mutation: 'none',
      reason: 'caller-unavailable',
      message: 'The invoking cmux terminal could not be re-identified before tab creation.',
    };
  }

  const createArgs = [
    '--socket',
    target.socketPath,
    'new-surface',
    '--type',
    'terminal',
    '--placement',
    'workspace',
    '--window',
    target.windowId,
    '--workspace',
    target.workspaceId,
    '--pane',
    target.paneId,
    '--working-directory',
    worktreePath,
    '--focus',
    'false',
  ];

  let create: ProcessResult;
  try {
    create = await run(cmuxFile, createArgs, worktreePath, env, options);
  } catch {
    return createMayExistResult(target);
  }
  if (create.outcome === 'spawn-failed') {
    await removeStagedTabLaunchScript(script);
    return {
      ok: false,
      mutation: 'none',
      reason: 'create-not-started',
      message: 'cmux tab creation could not start.',
    };
  }

  const created = parseCmuxTabCreateResult(create);
  if (created === null) return createMayExistResult(target);

  const sendArgs = [
    '--socket',
    target.socketPath,
    'send',
    '--workspace',
    target.workspaceId,
    '--surface',
    created.surfaceRef,
    `${script.path}\\r`,
  ];
  let send: ProcessResult;
  try {
    send = await run(cmuxFile, sendArgs, worktreePath, env, options);
  } catch {
    return sendFailedResult(created.surfaceRef, target);
  }
  if (!processSucceeded(send)) return sendFailedResult(created.surfaceRef, target);

  return { ok: true, mutation: 'exists', surfaceRef: created.surfaceRef, target };
}

export async function launchCmuxWorkspace(
  branch: string,
  worktreePath: string,
  options: CmuxOptions = {},
  recipe: CmuxLaunchRecipe = { mode: 'fresh' },
): Promise<CmuxLaunchResult> {
  const env = options.env ?? process.env;
  const activeAgentDir = options.activeAgentDir ?? resolve(process.cwd(), getAgentDir());
  const cmuxFile = await resolveCmuxExecutable(env);
  const result = await run(
    cmuxFile,
    buildWorkspaceCreateArgs(branch, worktreePath, activeAgentDir, recipe),
    worktreePath,
    env,
    options,
  );
  if (result.outcome === 'timeout' || result.outcome === 'signal') {
    return {
      ok: false,
      reason: 'launch-unknown',
      message: `${processError(result)}; cmux workspace creation may have completed.`,
    };
  }
  if (!processSucceeded(result)) {
    return {
      ok: false,
      reason: 'launch-failed',
      message: processError(result),
    };
  }
  return { ok: true };
}

interface StagedTabLaunchScript {
  directory: string;
  path: string;
}

const TAB_SCRIPT_DIRECTORY_PREFIX = '/tmp/pi-cmux-junction-tab-';
const TAB_SCRIPT_DIRECTORY_PATTERN = /^\/tmp\/pi-cmux-junction-tab-[A-Za-z0-9]+$/;
const TAB_SCRIPT_NAME = 'launch.sh';
const CMUX_TAB_CREATE_RESPONSE =
  /^OK (surface:[1-9][0-9]*) (pane:[1-9][0-9]*) (workspace:[1-9][0-9]*)\n$/;

async function resolveAndIdentifyCmuxCaller(
  cwd: string,
  target: CmuxTarget,
  options: CmuxOptions,
): Promise<CmuxTabCaller | null> {
  let resolved: CmuxTargetResolution;
  try {
    resolved = await resolveCmuxTarget(cwd, target, options);
  } catch {
    return null;
  }
  if (!resolved.ok) return null;

  const env = options.env ?? process.env;
  let result: ProcessResult;
  try {
    const cmuxFile = await resolveCmuxExecutable(env);
    result = await run(
      cmuxFile,
      [
        '--socket',
        resolved.socketPath,
        'identify',
        '--id-format',
        'both',
        '--json',
        '--workspace',
        resolved.workspaceId,
        '--surface',
        resolved.surfaceId,
      ],
      cwd,
      env,
      options,
    );
  } catch {
    return null;
  }
  if (!processSucceeded(result)) return null;
  return parseCmuxCaller(result.stdout, resolved);
}

function parseCmuxCaller(stdout: string, target: CmuxTarget): CmuxTabCaller | null {
  let value: unknown;
  try {
    value = JSON.parse(stdout.trim());
  } catch {
    return null;
  }
  if (!isRecord(value) || !isRecord(value['caller'])) return null;

  const caller = value['caller'];
  const windowId = parseUuid(caller['window_id']);
  const workspaceId = parseUuid(caller['workspace_id']);
  const paneId = parseUuid(caller['pane_id']);
  const surfaceId = parseUuid(caller['surface_id']);
  if (
    windowId === null ||
    workspaceId === null ||
    paneId === null ||
    surfaceId === null ||
    workspaceId !== target.workspaceId ||
    surfaceId !== target.surfaceId ||
    caller['surface_type'] !== 'terminal' ||
    caller['is_browser_surface'] !== false
  ) {
    return null;
  }
  return { socketPath: target.socketPath, windowId, workspaceId, paneId, surfaceId };
}

async function stageTabLaunchScript(
  activeAgentDir: string,
  recipe: CmuxLaunchRecipe,
): Promise<StagedTabLaunchScript> {
  const values = [activeAgentDir, ...(recipe.mode === 'fork' ? [recipe.sourceSessionFile] : [])];
  if (values.some((value) => value.includes('\0'))) throw new Error('invalid script value');

  const directory = await mkdtemp(TAB_SCRIPT_DIRECTORY_PREFIX);
  if (!isPrivateTabScriptDirectory(directory)) throw new Error('invalid script directory');

  const path = join(directory, TAB_SCRIPT_NAME);
  try {
    await chmod(directory, 0o700);
    await writeFile(path, buildTabLaunchScript(activeAgentDir, recipe), {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o700,
    });
    await chmod(path, 0o700);
    return { directory, path };
  } catch (error) {
    await rm(directory, { force: true, recursive: true });
    throw error;
  }
}

function buildTabLaunchScript(activeAgentDir: string, recipe: CmuxLaunchRecipe): string {
  return [
    '#!/bin/sh',
    'set -eu',
    'script_path=$0',
    'script_dir=${script_path%/*}',
    'rm -f "$script_path"',
    'rmdir "$script_dir"',
    `export ${PI_CODING_AGENT_DIR_ENV}=${quoteShellValue(activeAgentDir)}`,
    ...(recipe.mode === 'fork'
      ? [
          `export ${SOURCE_SESSION_ENV}=${quoteShellValue(recipe.sourceSessionFile)}`,
          FORK_PI_COMMAND,
        ]
      : [FRESH_PI_COMMAND]),
    '',
  ].join('\n');
}

function quoteShellValue(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function isPrivateTabScriptDirectory(path: string): boolean {
  return TAB_SCRIPT_DIRECTORY_PATTERN.test(path);
}

async function removeStagedTabLaunchScript(script: StagedTabLaunchScript): Promise<void> {
  if (!isPrivateTabScriptDirectory(script.directory)) return;
  await rm(script.directory, { force: true, recursive: true }).catch(() => undefined);
}

function parseCmuxTabCreateResult(result: ProcessResult): { surfaceRef: string } | null {
  if (!processSucceeded(result) || result.stderr !== '') return null;
  const match = CMUX_TAB_CREATE_RESPONSE.exec(result.stdout);
  const surfaceRef = match?.[1];
  return surfaceRef === undefined || match?.[0] !== result.stdout ? null : { surfaceRef };
}

function createMayExistResult(target: CmuxTabCaller): CmuxTabLaunchResult {
  return {
    ok: false,
    mutation: 'may-exist',
    reason: 'create-unknown',
    target,
    message: `cmux tab creation may have completed in window ${target.windowId}, workspace ${target.workspaceId}, pane ${target.paneId}.`,
  };
}

function sendFailedResult(surfaceRef: string, target: CmuxTabCaller): CmuxTabLaunchResult {
  return {
    ok: false,
    mutation: 'exists',
    reason: 'send-failed',
    surfaceRef,
    target,
    message: `cmux created ${surfaceRef}, but Pi launch submission failed; the tab may be blank or partially launched.`,
  };
}

function parseUuid(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  return /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value) ? value : null;
}

async function run(
  file: string,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  options: CmuxOptions,
  maxBufferBytes?: number,
) {
  return await (options.runner ?? defaultProcessRunner)(file, args, {
    cwd,
    env,
    shell: false,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(maxBufferBytes === undefined ? {} : { maxBufferBytes }),
  });
}

function parseResolvedTarget(
  stdout: string,
  claimedSurfaceId: string,
): { workspaceId: string; surfaceId: string } | null {
  let value: unknown;
  try {
    value = JSON.parse(stdout.trim());
  } catch {
    return null;
  }
  if (!isRecord(value) || value['source'] !== 'surface') return null;

  const workspaceId = normalizeTargetIdentity(value['workspace_id']);
  const surfaceId = normalizeTargetIdentity(value['surface_id']);
  if (workspaceId === null || surfaceId === null || surfaceId !== claimedSurfaceId) {
    return null;
  }
  return { workspaceId, surfaceId };
}

function normalizeTargetIdentity(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > 256) return null;
  for (const character of normalized) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return null;
  }
  return normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

import { access, chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  hashSessionDeckIterm2Content,
  readSessionDeckIterm2InstallState,
  writeSessionDeckIterm2InstallState,
  SESSION_DECK_ITERM2_PRODUCT,
  SESSION_DECK_ITERM2_STATE_SCHEMA_VERSION,
  type SessionDeckIterm2InstallState,
} from './state.js';
import {
  getDefaultSessionDeckIterm2ScriptsDir,
  getSessionDeckIterm2AutoLaunchDir,
  getSessionDeckIterm2ScriptPath,
  getSessionDeckIterm2StatePath,
  getSessionDeckIterm2WebAssetPaths,
  normalizeSessionDeckIterm2ScriptsDir,
  resolveSessionDeckIterm2RuntimePaths,
  type SessionDeckIterm2RuntimePaths,
} from './paths.js';
import type { SessionDeckIterm2CommandResult } from './command.js';

type AutolaunchScriptSnapshot = {
  content: Buffer;
  mode: number;
} | null;

export interface InstallSessionDeckIterm2Options {
  homeDirectory?: string;
  now?: () => Date;
  platform?: NodeJS.Platform;
  runtimePaths?: SessionDeckIterm2RuntimePaths;
  scriptsDir?: string;
  statePath?: string;
}

export async function installSessionDeckIterm2(
  options: InstallSessionDeckIterm2Options = {},
): Promise<SessionDeckIterm2CommandResult> {
  if ((options.platform ?? process.platform) !== 'darwin') {
    return {
      level: 'error',
      message: 'iTerm2 Toolbelt install is only supported on macOS.',
    };
  }

  const homeDirectory = options.homeDirectory ?? homedir();
  const statePath = options.statePath ?? getSessionDeckIterm2StatePath(homeDirectory);
  let existingState: SessionDeckIterm2InstallState | null;
  try {
    existingState = await readSessionDeckIterm2InstallState(statePath);
  } catch (error) {
    return {
      level: 'error',
      message: [
        'Could not install Session Deck iTerm2 Toolbelt.',
        `State file at ${statePath} is invalid: ${getErrorMessage(error)}`,
        'Remove or repair the state file and verify/remove any existing Session Deck AutoLaunch script manually before installing.',
      ].join('\n'),
    };
  }

  const scriptsDir = normalizeSessionDeckIterm2ScriptsDir(
    options.scriptsDir ??
      existingState?.scriptsDir ??
      getDefaultSessionDeckIterm2ScriptsDir(homeDirectory),
  );
  const targetScriptPath = getSessionDeckIterm2ScriptPath(scriptsDir);

  if (existingState !== null && existingState.script.path !== targetScriptPath) {
    return {
      level: 'error',
      message: [
        'Could not install Session Deck iTerm2 Toolbelt.',
        `Existing state owns ${existingState.script.path}.`,
        `Requested install target is ${targetScriptPath}.`,
        'Run /session-deck iterm2 uninstall first, or install with the same scripts directory.',
      ].join('\n'),
    };
  }

  if ((await pathExists(targetScriptPath)) && existingState === null) {
    return {
      level: 'error',
      message: [
        'Could not install Session Deck iTerm2 Toolbelt.',
        `AutoLaunch target already exists and is not owned by Session Deck state: ${targetScriptPath}`,
        'Nothing was overwritten. Remove or verify the existing script manually, then rerun /session-deck iterm2 install.',
      ].join('\n'),
    };
  }

  const runtimePaths =
    options.runtimePaths ?? (await resolveSessionDeckIterm2RuntimePaths(import.meta.url));
  const missingAsset = await findMissingRuntimeAsset(runtimePaths);
  if (missingAsset !== null) {
    return {
      level: 'error',
      message: `${missingAsset.message}\nRun \`pnpm --dir packages/pi-session-deck run build\` and try again.`,
    };
  }

  const autolaunchSource = await readFile(runtimePaths.autolaunchSourcePath);
  const scriptHash = hashSessionDeckIterm2Content(autolaunchSource);
  const state: SessionDeckIterm2InstallState = {
    schemaVersion: SESSION_DECK_ITERM2_STATE_SCHEMA_VERSION,
    product: SESSION_DECK_ITERM2_PRODUCT,
    packageVersion: runtimePaths.packageVersion,
    installedAt: (options.now ?? (() => new Date()))().toISOString(),
    scriptsDir,
    script: {
      path: targetScriptPath,
      sha256: scriptHash,
    },
    runtime: {
      nodeExecutablePath: runtimePaths.nodeExecutablePath,
      snapshotHelperPath: runtimePaths.snapshotHelperPath,
      webRootPath: runtimePaths.webRootPath,
      bridgeSocketPath: runtimePaths.bridgeSocketPath,
    },
  };

  await mkdir(getSessionDeckIterm2AutoLaunchDir(scriptsDir), { recursive: true });
  const previousScript = await snapshotAutolaunchScript(targetScriptPath);
  await writeAutolaunchScriptAtomic(targetScriptPath, autolaunchSource);
  try {
    await writeSessionDeckIterm2InstallState(statePath, state);
  } catch (error) {
    const rollbackMessage = await rollbackAutolaunchScript(targetScriptPath, previousScript);
    return {
      level: 'error',
      message: [
        'Could not install Session Deck iTerm2 Toolbelt.',
        `Install state at ${statePath} could not be written: ${getErrorMessage(error)}`,
        rollbackMessage,
      ].join('\n'),
    };
  }

  return {
    level: 'info',
    message: [
      'Installed Session Deck iTerm2 Toolbelt.',
      `AutoLaunch script: ${targetScriptPath}`,
      `State: ${statePath}`,
      `Bridge socket: ${runtimePaths.bridgeSocketPath}`,
      'Next: enable iTerm2 Python API if needed, then restart iTerm2 and open Toolbelt → Session Deck.',
    ].join('\n'),
  };
}

async function findMissingRuntimeAsset(
  runtimePaths: SessionDeckIterm2RuntimePaths,
): Promise<{ message: string } | null> {
  if (!(await pathExists(runtimePaths.autolaunchSourcePath))) {
    return {
      message: `iTerm2 AutoLaunch source not found: ${runtimePaths.autolaunchSourcePath}`,
    };
  }

  if (!(await pathExists(runtimePaths.snapshotHelperPath))) {
    return {
      message: `Snapshot helper not found: ${runtimePaths.snapshotHelperPath}`,
    };
  }

  if (!(await pathExists(runtimePaths.createWorktreeHelperScriptPath))) {
    return {
      message: `Create-worktree helper not found: ${runtimePaths.createWorktreeHelperScriptPath}`,
    };
  }

  if (!(await pathExists(runtimePaths.openTerminalHelperScriptPath))) {
    return {
      message: `Open-terminal helper not found: ${runtimePaths.openTerminalHelperScriptPath}`,
    };
  }

  if (!(await pathExists(runtimePaths.killSessionHelperScriptPath))) {
    return {
      message: `Kill-session helper not found: ${runtimePaths.killSessionHelperScriptPath}`,
    };
  }

  if (!(await pathExists(runtimePaths.webRootPath))) {
    return {
      message: `Web assets not found: ${runtimePaths.webRootPath}`,
    };
  }

  const webAssets = getSessionDeckIterm2WebAssetPaths(runtimePaths.webRootPath);
  const requiredAssets = [
    { label: 'Web index', path: webAssets.indexPath },
    { label: 'Web bootstrap', path: webAssets.appPath },
    { label: 'Web shared UI', path: webAssets.sharedUiPath },
    { label: 'Web iTerm2 host', path: webAssets.hostPath },
    { label: 'Web launch-context view helper', path: webAssets.launchContextViewPath },
    { label: 'Web stylesheet', path: webAssets.stylePath },
  ];

  for (const asset of requiredAssets) {
    if (!(await pathExists(asset.path))) {
      return {
        message: `${asset.label} not found: ${asset.path}`,
      };
    }
  }

  return null;
}

async function snapshotAutolaunchScript(targetPath: string): Promise<AutolaunchScriptSnapshot> {
  try {
    const [content, scriptStat] = await Promise.all([readFile(targetPath), stat(targetPath)]);
    return {
      content,
      mode: scriptStat.mode & 0o777,
    };
  } catch (error) {
    if (isMissingFileError(error)) {
      return null;
    }
    throw error;
  }
}

async function rollbackAutolaunchScript(
  targetPath: string,
  previousScript: AutolaunchScriptSnapshot,
): Promise<string> {
  if (previousScript === null) {
    await rm(targetPath, { force: true });
    return `Rolled back newly written AutoLaunch script: ${targetPath}`;
  }

  await writeAutolaunchScriptAtomic(targetPath, previousScript.content, previousScript.mode);
  return `Restored previously owned AutoLaunch script: ${targetPath}`;
}

async function writeAutolaunchScriptAtomic(
  targetPath: string,
  content: Buffer,
  mode: number = 0o755,
): Promise<void> {
  const targetDir = dirname(targetPath);
  const tempPath = join(targetDir, `.session-deck-iterm2.${process.pid}.${randomUUID()}.tmp`);
  try {
    await writeFile(tempPath, content, { mode });
    await chmod(tempPath, mode);
    await rename(tempPath, targetPath);
    await chmod(targetPath, mode);
  } catch (error) {
    await rm(tempPath, { force: true });
    throw error;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

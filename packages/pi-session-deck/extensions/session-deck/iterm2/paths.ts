import { access, readFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SESSION_DECK_ITERM2_SUBCOMMAND = 'iterm2';
export const SESSION_DECK_ITERM2_INSTALL_ACTION = 'install';
export const SESSION_DECK_ITERM2_UNINSTALL_ACTION = 'uninstall';
export const SESSION_DECK_ITERM2_DOCTOR_ACTION = 'doctor';
export const SESSION_DECK_ITERM2_SCRIPTS_DIR_FLAG = '--scripts-dir';
export const SESSION_DECK_ITERM2_TOOL_IDENTIFIER = 'dev.pi-userland.session-deck.toolbelt';
export const SESSION_DECK_ITERM2_TOOL_DISPLAY_NAME = 'Session Deck';
export const SESSION_DECK_ITERM2_SCRIPT_FILENAME = 'session_deck.py';
export const SESSION_DECK_ITERM2_STATE_FILENAME = 'install.json';
export const SESSION_DECK_ITERM2_HELPER_RELATIVE_PATH =
  'dist/extensions/session-deck/iterm2/snapshot-cli.js';
export const SESSION_DECK_ITERM2_CREATE_WORKTREE_HELPER_RELATIVE_PATH =
  'dist/extensions/session-deck/worktree/action-cli.js';
export const SESSION_DECK_ITERM2_OPEN_HELPER_RELATIVE_PATH =
  'dist/extensions/session-deck/iterm2/open-action-cli.js';
export const SESSION_DECK_ITERM2_WEB_ROOT_RELATIVE_PATH = 'extensions/session-deck/iterm2/web';
export const SESSION_DECK_ITERM2_AUTOLAUNCH_SOURCE_RELATIVE_PATH =
  'extensions/session-deck/iterm2/autolaunch.py';
export const SESSION_DECK_ITERM2_WEB_INDEX_FILENAME = 'index.html';
export const SESSION_DECK_ITERM2_WEB_APP_FILENAME = 'app.js';
export const SESSION_DECK_ITERM2_WEB_STYLE_FILENAME = 'style.css';

export interface SessionDeckIterm2RuntimePaths {
  packageRoot: string;
  packageVersion: string;
  nodeExecutablePath: string;
  snapshotHelperPath: string;
  createWorktreeHelperScriptPath: string;
  openTerminalHelperScriptPath: string;
  webRootPath: string;
  autolaunchSourcePath: string;
  bridgeSocketPath: string;
}

export function getDefaultSessionDeckIterm2ScriptsDir(homeDirectory: string = homedir()): string {
  return join(homeDirectory, 'Library', 'Application Support', 'iTerm2', 'Scripts');
}

export function normalizeSessionDeckIterm2ScriptsDir(scriptsDir: string): string {
  const trimmed = scriptsDir.trim();
  if (trimmed.length === 0) {
    return trimmed;
  }

  const scriptsRoot = basename(trimmed) === 'AutoLaunch' ? dirname(trimmed) : trimmed;
  return resolve(scriptsRoot);
}

export function getSessionDeckIterm2AutoLaunchDir(scriptsDir: string): string {
  return join(scriptsDir, 'AutoLaunch');
}

export function getSessionDeckIterm2ScriptPath(scriptsDir: string): string {
  return join(getSessionDeckIterm2AutoLaunchDir(scriptsDir), SESSION_DECK_ITERM2_SCRIPT_FILENAME);
}

export function getSessionDeckIterm2StateDir(homeDirectory: string = homedir()): string {
  return join(homeDirectory, '.pi', 'session-deck', 'iterm2');
}

export function getSessionDeckIterm2StatePath(homeDirectory: string = homedir()): string {
  return join(getSessionDeckIterm2StateDir(homeDirectory), SESSION_DECK_ITERM2_STATE_FILENAME);
}

export function getSessionDeckIterm2BridgeSocketPath(
  uid: number | string = getCurrentUid(),
): string {
  return join(tmpdir(), `pi-session-deck-${uid}`, 'iterm2.sock');
}

export function getSessionDeckIterm2WebAssetPaths(webRootPath: string): {
  indexPath: string;
  appPath: string;
  stylePath: string;
} {
  return {
    indexPath: join(webRootPath, SESSION_DECK_ITERM2_WEB_INDEX_FILENAME),
    appPath: join(webRootPath, SESSION_DECK_ITERM2_WEB_APP_FILENAME),
    stylePath: join(webRootPath, SESSION_DECK_ITERM2_WEB_STYLE_FILENAME),
  };
}

export async function resolveSessionDeckIterm2RuntimePaths(
  importMetaUrl: string,
  options: {
    bridgeSocketPath?: string;
    nodeExecutablePath?: string;
    packageName?: string;
  } = {},
): Promise<SessionDeckIterm2RuntimePaths> {
  const packageName = options.packageName ?? '@robhowley/pi-session-deck';
  const packageRoot = await findPackageRoot(dirname(fileURLToPath(importMetaUrl)), packageName);
  const packageJson = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8')) as {
    version?: string;
  };
  const packageVersion = packageJson.version;
  if (typeof packageVersion !== 'string' || packageVersion.length === 0) {
    throw new Error(
      `Could not determine package version from ${join(packageRoot, 'package.json')}.`,
    );
  }

  return {
    packageRoot,
    packageVersion,
    nodeExecutablePath: options.nodeExecutablePath ?? process.execPath,
    snapshotHelperPath: join(packageRoot, SESSION_DECK_ITERM2_HELPER_RELATIVE_PATH),
    createWorktreeHelperScriptPath: join(
      packageRoot,
      SESSION_DECK_ITERM2_CREATE_WORKTREE_HELPER_RELATIVE_PATH,
    ),
    openTerminalHelperScriptPath: join(packageRoot, SESSION_DECK_ITERM2_OPEN_HELPER_RELATIVE_PATH),
    webRootPath: join(packageRoot, SESSION_DECK_ITERM2_WEB_ROOT_RELATIVE_PATH),
    autolaunchSourcePath: join(packageRoot, SESSION_DECK_ITERM2_AUTOLAUNCH_SOURCE_RELATIVE_PATH),
    bridgeSocketPath: options.bridgeSocketPath ?? getSessionDeckIterm2BridgeSocketPath(),
  };
}

async function findPackageRoot(startDirectory: string, packageName: string): Promise<string> {
  let currentDirectory = resolve(startDirectory);

  while (true) {
    const packageJsonPath = join(currentDirectory, 'package.json');
    if (await pathExists(packageJsonPath)) {
      const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8')) as { name?: string };
      if (packageJson.name === packageName) {
        return currentDirectory;
      }
    }

    const parentDirectory = dirname(currentDirectory);
    if (parentDirectory === currentDirectory) {
      break;
    }
    currentDirectory = parentDirectory;
  }

  throw new Error(`Could not find package root for ${packageName}.`);
}

function getCurrentUid(): number | string {
  return typeof process.getuid === 'function' ? process.getuid() : 'user';
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

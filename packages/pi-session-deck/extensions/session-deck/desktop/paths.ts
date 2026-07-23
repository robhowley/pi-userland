import { access, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SESSION_DECK_DESKTOP_SUBCOMMAND = 'desktop';
export const SESSION_DECK_DESKTOP_INSTALL_ACTION = 'install';
export const SESSION_DECK_DESKTOP_OPEN_ACTION = 'open';
export const SESSION_DECK_DESKTOP_UNINSTALL_ACTION = 'uninstall';
export const SESSION_DECK_DESKTOP_DOCTOR_ACTION = 'doctor';
export const SESSION_DECK_DESKTOP_FROM_PATH_FLAG = '--from-path';
export const SESSION_DECK_DESKTOP_VERSION_FLAG = '--version';
export const SESSION_DECK_DESKTOP_SHA256_FLAG = '--sha256';
export const SESSION_DECK_DESKTOP_PACKAGE_NAME = '@robhowley/pi-session-deck';
export const SESSION_DECK_DESKTOP_APP_BUNDLE_NAME = 'Session Deck Desktop.app';
export const SESSION_DECK_DESKTOP_BUNDLE_IDENTIFIER = 'dev.pi-userland.session-deck.desktop';
export const SESSION_DECK_DESKTOP_STATE_FILENAME = 'install.json';
export const SESSION_DECK_DESKTOP_RELEASE_OWNER = 'robhowley';
export const SESSION_DECK_DESKTOP_RELEASE_REPO = 'pi-userland';

export interface SessionDeckDesktopRuntimePaths {
  packageRoot: string;
  packageVersion: string;
  nodeExecutablePath: string;
}

export type SessionDeckDesktopAssetPlatform = 'macos-arm64' | 'macos-x64';

export function getDefaultSessionDeckDesktopAppPath(homeDirectory: string = homedir()): string {
  return join(homeDirectory, 'Applications', SESSION_DECK_DESKTOP_APP_BUNDLE_NAME);
}

export function getSessionDeckDesktopStateDir(homeDirectory: string = homedir()): string {
  return join(homeDirectory, '.pi', 'session-deck', 'desktop');
}

export function getSessionDeckDesktopStatePath(homeDirectory: string = homedir()): string {
  return join(getSessionDeckDesktopStateDir(homeDirectory), SESSION_DECK_DESKTOP_STATE_FILENAME);
}

export function getSessionDeckDesktopTmpDir(homeDirectory: string = homedir()): string {
  return join(getSessionDeckDesktopStateDir(homeDirectory), 'tmp');
}

export function getSessionDeckDesktopCacheDir(homeDirectory: string = homedir()): string {
  return join(getSessionDeckDesktopStateDir(homeDirectory), 'cache');
}

export function getSessionDeckDesktopReleaseTag(version: string): string {
  return `pi-session-deck-v${normalizeVersion(version)}`;
}

export function getSessionDeckDesktopArtifactName(
  version: string,
  options: { platform?: NodeJS.Platform; arch?: NodeJS.Architecture } = {},
): string {
  return `session-deck-desktop-v${normalizeVersion(version)}-${getSessionDeckDesktopAssetPlatform(options)}.zip`;
}

export function getSessionDeckDesktopAssetPlatform(
  options: { platform?: NodeJS.Platform; arch?: NodeJS.Architecture } = {},
): SessionDeckDesktopAssetPlatform {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;

  if (platform !== 'darwin') {
    throw new Error(
      `Session Deck desktop artifacts are only available for macOS, not ${platform}.`,
    );
  }

  if (arch === 'arm64') {
    return 'macos-arm64';
  }

  if (arch === 'x64') {
    return 'macos-x64';
  }

  throw new Error(`Session Deck desktop artifacts are not available for macOS ${arch}.`);
}

export async function resolveSessionDeckDesktopRuntimePaths(
  importMetaUrl: string,
  options: {
    nodeExecutablePath?: string;
    packageName?: string;
  } = {},
): Promise<SessionDeckDesktopRuntimePaths> {
  const packageName = options.packageName ?? SESSION_DECK_DESKTOP_PACKAGE_NAME;
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
  };
}

function normalizeVersion(version: string): string {
  const trimmed = version.trim();
  return trimmed.startsWith('v') ? trimmed.slice(1) : trimmed;
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

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

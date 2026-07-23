import { access, lstat, readFile, readdir } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { SESSION_DECK_DESKTOP_BUNDLE_IDENTIFIER } from './paths.js';

export interface SessionDeckDesktopBundleMetadata {
  path: string;
  bundleIdentifier: typeof SESSION_DECK_DESKTOP_BUNDLE_IDENTIFIER;
  name: string;
  version: string;
}

export async function validateSessionDeckDesktopAppBundle(
  appPath: string,
  options: {
    expectedBundleIdentifier?: typeof SESSION_DECK_DESKTOP_BUNDLE_IDENTIFIER;
  } = {},
): Promise<SessionDeckDesktopBundleMetadata> {
  const expectedBundleIdentifier =
    options.expectedBundleIdentifier ?? SESSION_DECK_DESKTOP_BUNDLE_IDENTIFIER;
  const appStat = await lstat(appPath);
  if (!appStat.isDirectory() || extname(appPath) !== '.app') {
    throw new Error(`Expected a macOS .app bundle directory: ${appPath}`);
  }

  const contentsPath = join(appPath, 'Contents');
  const macosPath = join(contentsPath, 'MacOS');
  const infoPlistPath = join(contentsPath, 'Info.plist');

  if (!(await pathIsDirectory(contentsPath))) {
    throw new Error(`App bundle is missing Contents directory: ${contentsPath}`);
  }

  if (!(await pathIsDirectory(macosPath))) {
    throw new Error(`App bundle is missing Contents/MacOS directory: ${macosPath}`);
  }

  const executableEntries = await readdir(macosPath);
  if (executableEntries.length === 0) {
    throw new Error(`App bundle Contents/MacOS has no executable entries: ${macosPath}`);
  }

  const plist = await readFile(infoPlistPath, 'utf8');
  const bundleIdentifier = readPlistString(plist, 'CFBundleIdentifier');
  if (bundleIdentifier !== expectedBundleIdentifier) {
    throw new Error(
      bundleIdentifier === null
        ? `App bundle Info.plist is missing CFBundleIdentifier: ${infoPlistPath}`
        : `App bundle identifier ${bundleIdentifier} does not match expected ${expectedBundleIdentifier}.`,
    );
  }

  const version =
    readPlistString(plist, 'CFBundleShortVersionString') ??
    readPlistString(plist, 'CFBundleVersion');
  if (version === null || version.trim().length === 0) {
    throw new Error(`App bundle Info.plist is missing a version string: ${infoPlistPath}`);
  }

  const name =
    readPlistString(plist, 'CFBundleDisplayName') ??
    readPlistString(plist, 'CFBundleName') ??
    basename(appPath, '.app');

  return {
    path: appPath,
    bundleIdentifier: SESSION_DECK_DESKTOP_BUNDLE_IDENTIFIER,
    name,
    version,
  };
}

function readPlistString(plist: string, key: string): string | null {
  const pattern = new RegExp(
    `<key>\\s*${escapeRegExp(key)}\\s*</key>\\s*<string>([\\s\\S]*?)</string>`,
    'u',
  );
  const match = plist.match(pattern);
  const value = match?.[1];
  return value === undefined ? null : decodeXmlEntities(value.trim());
}

function decodeXmlEntities(value: string): string {
  return value
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

async function pathIsDirectory(path: string): Promise<boolean> {
  try {
    const pathStat = await lstat(path);
    return pathStat.isDirectory();
  } catch (error) {
    if (isMissingFileError(error)) {
      return false;
    }
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

export async function findSessionDeckDesktopAppBundle(rootPath: string): Promise<string> {
  const candidates = await findAppBundles(rootPath);
  const sessionDeckCandidate = candidates.find(
    (candidate) => basename(candidate) === 'Session Deck Desktop.app',
  );
  if (sessionDeckCandidate !== undefined) {
    return sessionDeckCandidate;
  }

  if (candidates.length === 1) {
    return candidates[0]!;
  }

  if (candidates.length === 0) {
    throw new Error(`No .app bundle found in ${rootPath}.`);
  }

  throw new Error(`Multiple .app bundles found in ${rootPath}; expected Session Deck Desktop.app.`);
}

async function findAppBundles(rootPath: string): Promise<string[]> {
  if (!(await pathExists(rootPath))) {
    throw new Error(`Artifact extraction path does not exist: ${rootPath}`);
  }

  const rootStat = await lstat(rootPath);
  if (!rootStat.isDirectory()) {
    return extname(rootPath) === '.app' ? [rootPath] : [];
  }

  if (extname(rootPath) === '.app') {
    return [rootPath];
  }

  const matches: string[] = [];
  const entries = (await readdir(rootPath, { withFileTypes: true })).sort((left, right) =>
    left.name.localeCompare(right.name),
  );
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const childPath = join(rootPath, entry.name);
    if (extname(childPath) === '.app') {
      matches.push(childPath);
      continue;
    }

    matches.push(...(await findAppBundles(childPath)));
  }

  return matches;
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

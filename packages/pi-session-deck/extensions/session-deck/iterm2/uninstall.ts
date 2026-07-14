import { rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import {
  readSessionDeckIterm2Manifest,
  type SessionDeckIterm2InstallManifest,
} from './manifest.js';
import { getSessionDeckIterm2ManifestPath, normalizeSessionDeckIterm2ScriptsDir } from './paths.js';
import type { SessionDeckIterm2CommandResult } from './command.js';

export interface UninstallSessionDeckIterm2Options {
  homeDirectory?: string;
  manifestPath?: string;
  scriptsDir?: string;
}

export async function uninstallSessionDeckIterm2(
  options: UninstallSessionDeckIterm2Options = {},
): Promise<SessionDeckIterm2CommandResult> {
  const homeDirectory = options.homeDirectory ?? homedir();
  const manifestPath = options.manifestPath ?? getSessionDeckIterm2ManifestPath(homeDirectory);
  let manifest: SessionDeckIterm2InstallManifest | null;
  try {
    manifest = await readSessionDeckIterm2Manifest(manifestPath);
  } catch (error) {
    return {
      level: 'warning',
      message: [
        'Could not uninstall Session Deck iTerm2 Toolbelt automatically.',
        `Install manifest at ${manifestPath} could not be read: ${getErrorMessage(error)}`,
        'Nothing was removed because script ownership could not be verified.',
        'Manual recovery required: remove or repair the manifest and verify/remove any Session Deck AutoLaunch script manually.',
      ].join('\n'),
    };
  }
  if (manifest === null) {
    return {
      level: 'warning',
      message: `No Session Deck iTerm2 install manifest found at ${manifestPath}.`,
    };
  }

  const lines = ['Uninstalled Session Deck iTerm2 Toolbelt.'];
  const overrideScriptsDir =
    options.scriptsDir === undefined
      ? undefined
      : normalizeSessionDeckIterm2ScriptsDir(options.scriptsDir);
  if (overrideScriptsDir !== undefined && overrideScriptsDir !== manifest.scriptsDir) {
    lines.push(
      `Ignored --scripts-dir ${overrideScriptsDir} because manifest ownership is ${manifest.scriptsDir}.`,
    );
  }

  await rm(manifest.generatedScriptPath, { force: true });
  await rm(manifestPath, { force: true });

  lines.push(`Removed script: ${manifest.generatedScriptPath}`);
  lines.push(`Removed manifest: ${manifestPath}`);

  return {
    level: 'info',
    message: lines.join('\n'),
  };
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

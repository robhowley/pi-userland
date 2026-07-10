import { rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { readSessionDeckIterm2Manifest } from './manifest.js';
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
  const manifest = await readSessionDeckIterm2Manifest(manifestPath);
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

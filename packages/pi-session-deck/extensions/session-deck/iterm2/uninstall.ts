import { rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import {
  getSessionDeckIterm2PythonBridgeArtifact,
  getSessionDeckIterm2ToolbeltArtifact,
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

  const toolbeltArtifact = getSessionDeckIterm2ToolbeltArtifact(manifest);
  const pythonBridgeArtifact = getSessionDeckIterm2PythonBridgeArtifact(manifest);

  await rm(toolbeltArtifact.path, { force: true });
  if (pythonBridgeArtifact !== null) {
    await rm(pythonBridgeArtifact.path, { force: true });
  }
  await rm(manifestPath, { force: true });

  lines.push(`Removed toolbelt script: ${toolbeltArtifact.path}`);
  if (pythonBridgeArtifact !== null) {
    lines.push(`Removed Python bridge: ${pythonBridgeArtifact.path}`);
  }
  lines.push(`Removed manifest: ${manifestPath}`);

  return {
    level: 'info',
    message: lines.join('\n'),
  };
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

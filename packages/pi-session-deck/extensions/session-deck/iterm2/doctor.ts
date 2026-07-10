import { access, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { readSessionDeckIterm2Manifest, hashSessionDeckIterm2Template } from './manifest.js';
import {
  getDefaultSessionDeckIterm2ScriptsDir,
  getSessionDeckIterm2ManifestPath,
  getSessionDeckIterm2ScriptPath,
  getSessionDeckIterm2WebAssetPaths,
  normalizeSessionDeckIterm2ScriptsDir,
  resolveSessionDeckIterm2RuntimePaths,
  type SessionDeckIterm2RuntimePaths,
} from './paths.js';
import { renderSessionDeckIterm2PythonScript } from './python-template.js';
import type { SessionDeckIterm2CommandResult } from './command.js';

export interface DoctorSessionDeckIterm2InstallOptions {
  homeDirectory?: string;
  manifestPath?: string;
  platform?: NodeJS.Platform;
  runtimePaths?: SessionDeckIterm2RuntimePaths;
  scriptsDir?: string;
}

export async function doctorSessionDeckIterm2Install(
  options: DoctorSessionDeckIterm2InstallOptions = {},
): Promise<SessionDeckIterm2CommandResult> {
  const homeDirectory = options.homeDirectory ?? homedir();
  const manifestPath = options.manifestPath ?? getSessionDeckIterm2ManifestPath(homeDirectory);
  const manifest = await readSessionDeckIterm2Manifest(manifestPath);
  const overrideScriptsDir =
    options.scriptsDir === undefined
      ? undefined
      : normalizeSessionDeckIterm2ScriptsDir(options.scriptsDir);
  const scriptsDir =
    overrideScriptsDir ??
    manifest?.scriptsDir ??
    getDefaultSessionDeckIterm2ScriptsDir(homeDirectory);
  const scriptPath = manifest?.generatedScriptPath ?? getSessionDeckIterm2ScriptPath(scriptsDir);

  const lines = ['Session Deck iTerm2 doctor'];
  const issues: string[] = [];

  const platform = options.platform ?? process.platform;
  lines.push(`- platform: ${platform}`);
  if (platform !== 'darwin') {
    issues.push('iTerm2 Toolbelt support is macOS-only.');
  }

  lines.push(`- scripts dir: ${scriptsDir}`);
  lines.push(`- manifest: ${manifest === null ? 'missing' : manifestPath}`);
  lines.push(`- script: ${scriptPath}${(await pathExists(scriptPath)) ? '' : ' (missing)'}`);

  let runtimePaths: SessionDeckIterm2RuntimePaths | null = options.runtimePaths ?? null;
  if (runtimePaths === null) {
    try {
      runtimePaths = await resolveSessionDeckIterm2RuntimePaths(import.meta.url);
    } catch (error) {
      issues.push(`Could not resolve current package runtime paths: ${getErrorMessage(error)}`);
    }
  }

  if (manifest === null) {
    issues.push(`Install manifest not found at ${manifestPath}. Run /session-deck iterm2 install.`);
  } else if (overrideScriptsDir !== undefined && overrideScriptsDir !== manifest.scriptsDir) {
    issues.push(
      `Requested scripts dir ${overrideScriptsDir} does not match manifest ownership ${manifest.scriptsDir}.`,
    );
  }

  if (runtimePaths !== null) {
    lines.push(
      `- helper: ${runtimePaths.helperScriptPath}${(await pathExists(runtimePaths.helperScriptPath)) ? '' : ' (missing)'}`,
    );
    lines.push(
      `- web root: ${runtimePaths.webRootPath}${(await pathExists(runtimePaths.webRootPath)) ? '' : ' (missing)'}`,
    );

    if (!(await pathExists(runtimePaths.helperScriptPath))) {
      issues.push(`Snapshot helper is missing: ${runtimePaths.helperScriptPath}`);
    }
    if (!(await pathExists(runtimePaths.webRootPath))) {
      issues.push(`Web assets are missing: ${runtimePaths.webRootPath}`);
    } else {
      const webAssets = getSessionDeckIterm2WebAssetPaths(runtimePaths.webRootPath);
      const requiredAssets = [
        { label: 'Web index', path: webAssets.indexPath },
        { label: 'Web app', path: webAssets.appPath },
        { label: 'Web stylesheet', path: webAssets.stylePath },
      ];

      for (const asset of requiredAssets) {
        if (!(await pathExists(asset.path))) {
          issues.push(`${asset.label} is missing: ${asset.path}`);
        }
      }
    }

    if (manifest !== null) {
      if (manifest.packageVersion !== runtimePaths.packageVersion) {
        issues.push(
          `Installed manifest version ${manifest.packageVersion} does not match current package version ${runtimePaths.packageVersion}. Reinstall recommended.`,
        );
      }
      if (manifest.helperScriptPath !== runtimePaths.helperScriptPath) {
        issues.push('Snapshot helper path changed since install. Reinstall recommended.');
      }
      if (manifest.webRootPath !== runtimePaths.webRootPath) {
        issues.push('Web asset path changed since install. Reinstall recommended.');
      }
      if (manifest.nodeExecutablePath !== runtimePaths.nodeExecutablePath) {
        issues.push('Node executable path changed since install. Reinstall recommended.');
      }

      const renderedScript = renderSessionDeckIterm2PythonScript({
        helperScriptPath: runtimePaths.helperScriptPath,
        nodeExecutablePath: runtimePaths.nodeExecutablePath,
        packageVersion: runtimePaths.packageVersion,
        webRootPath: runtimePaths.webRootPath,
      });
      const expectedHash = hashSessionDeckIterm2Template(renderedScript);
      if (manifest.templateHash !== expectedHash) {
        issues.push(
          'Generated script template hash is stale for the current package. Reinstall recommended.',
        );
      }

      if (await pathExists(scriptPath)) {
        const installedScript = await readFile(scriptPath, 'utf8');
        if (installedScript !== renderedScript) {
          issues.push(
            'Installed AutoLaunch script differs from the current package template. Reinstall recommended.',
          );
        }
      }
    }
  }

  if (!(await pathExists(scriptPath)) && manifest !== null) {
    issues.push(`Installed AutoLaunch script is missing: ${scriptPath}`);
  }

  lines.push(
    '- manual: enable iTerm2 Python API if needed, then restart iTerm2 after install changes.',
  );

  if (issues.length > 0) {
    lines.push('');
    lines.push('Issues:');
    for (const issue of issues) {
      lines.push(`- ${issue}`);
    }
  }

  return {
    level: issues.length === 0 ? 'info' : 'warning',
    message: lines.join('\n'),
  };
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

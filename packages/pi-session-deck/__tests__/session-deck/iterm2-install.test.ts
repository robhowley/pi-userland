import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { readSessionDeckIterm2Manifest } from '../../extensions/session-deck/iterm2/manifest.js';
import { doctorSessionDeckIterm2Install } from '../../extensions/session-deck/iterm2/doctor.js';
import { installSessionDeckIterm2 } from '../../extensions/session-deck/iterm2/install.js';
import { uninstallSessionDeckIterm2 } from '../../extensions/session-deck/iterm2/uninstall.js';
import {
  getSessionDeckIterm2ManifestPath,
  getSessionDeckIterm2ScriptPath,
  type SessionDeckIterm2RuntimePaths,
} from '../../extensions/session-deck/iterm2/paths.js';
import { renderSessionDeckIterm2PythonScript } from '../../extensions/session-deck/iterm2/python-template.js';

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

async function createTempHome(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'session-deck-iterm2-'));
  tempDirectories.push(directory);
  return directory;
}

async function expectPathMissing(path: string): Promise<void> {
  await expect(readFile(path, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
}

async function createRuntimePaths(
  root: string,
  options: { includeAppJs?: boolean } = {},
): Promise<SessionDeckIterm2RuntimePaths> {
  const helperScriptPath = join(
    root,
    'dist',
    'extensions',
    'session-deck',
    'iterm2',
    'snapshot-cli.js',
  );
  const webRootPath = join(root, 'extensions', 'session-deck', 'iterm2', 'web');

  await mkdir(join(helperScriptPath, '..'), { recursive: true });
  await mkdir(webRootPath, { recursive: true });
  await writeFile(helperScriptPath, 'console.log("snapshot")\n', 'utf8');
  await writeFile(join(webRootPath, 'index.html'), '<!doctype html>\n', 'utf8');
  if (options.includeAppJs !== false) {
    await writeFile(join(webRootPath, 'app.js'), 'console.log("app")\n', 'utf8');
  }
  await writeFile(join(webRootPath, 'style.css'), 'body{}\n', 'utf8');

  return {
    packageRoot: root,
    packageVersion: '1.2.3',
    nodeExecutablePath: '/usr/local/bin/node',
    helperScriptPath,
    webRootPath,
  };
}

describe('session-deck iterm2 install + doctor', () => {
  it('writes the generated AutoLaunch script and manifest, normalizing an AutoLaunch override', async () => {
    const homeDirectory = await createTempHome();
    const runtimePaths = await createRuntimePaths(join(homeDirectory, 'package-root'));
    const scriptsDir = join(
      homeDirectory,
      'Library',
      'Application Support',
      'iTerm2',
      'Scripts',
      'AutoLaunch',
    );
    const manifestPath = getSessionDeckIterm2ManifestPath(homeDirectory);
    const expectedScriptsDir = join(
      homeDirectory,
      'Library',
      'Application Support',
      'iTerm2',
      'Scripts',
    );
    const expectedScriptPath = getSessionDeckIterm2ScriptPath(expectedScriptsDir);

    const result = await installSessionDeckIterm2({
      homeDirectory,
      now: () => new Date('2026-07-10T12:00:00.000Z'),
      platform: 'darwin',
      runtimePaths,
      scriptsDir,
    });

    expect(result.level).toBe('info');
    expect(result.message).toContain('Installed Session Deck iTerm2 Toolbelt.');
    expect(result.message).toContain(`Script: ${expectedScriptPath}`);
    expect(result.message).toContain(`Manifest: ${manifestPath}`);

    const manifest = await readSessionDeckIterm2Manifest(manifestPath);
    expect(manifest).toEqual({
      schemaVersion: 1,
      packageVersion: '1.2.3',
      installedAt: '2026-07-10T12:00:00.000Z',
      scriptsDir: expectedScriptsDir,
      generatedScriptPath: expectedScriptPath,
      nodeExecutablePath: runtimePaths.nodeExecutablePath,
      helperScriptPath: runtimePaths.helperScriptPath,
      webRootPath: runtimePaths.webRootPath,
      templateHash: expect.any(String),
    });

    const installedScript = await readFile(expectedScriptPath, 'utf8');
    expect(installedScript).toBe(
      renderSessionDeckIterm2PythonScript({
        helperScriptPath: runtimePaths.helperScriptPath,
        nodeExecutablePath: runtimePaths.nodeExecutablePath,
        packageVersion: runtimePaths.packageVersion,
        webRootPath: runtimePaths.webRootPath,
      }),
    );
  });

  it('fails install when a required web asset is missing and points local devs at the build step', async () => {
    const homeDirectory = await createTempHome();
    const runtimePaths = await createRuntimePaths(join(homeDirectory, 'package-root'), {
      includeAppJs: false,
    });

    const result = await installSessionDeckIterm2({
      homeDirectory,
      platform: 'darwin',
      runtimePaths,
    });

    expect(result).toEqual({
      level: 'error',
      message: `Web app not found: ${join(runtimePaths.webRootPath, 'app.js')}\nRun \`pnpm --dir packages/pi-session-deck run build\` and try again.`,
    });
  });

  it('doctor surfaces template drift, missing web assets, and override mismatch without mutating anything', async () => {
    const homeDirectory = await createTempHome();
    const runtimePaths = await createRuntimePaths(join(homeDirectory, 'package-root'));
    const scriptsDir = join(homeDirectory, 'Library', 'Application Support', 'iTerm2', 'Scripts');
    const scriptPath = getSessionDeckIterm2ScriptPath(scriptsDir);

    await installSessionDeckIterm2({
      homeDirectory,
      now: () => new Date('2026-07-10T12:00:00.000Z'),
      platform: 'darwin',
      runtimePaths,
      scriptsDir,
    });

    await writeFile(scriptPath, '# drifted script\n', 'utf8');
    await rm(join(runtimePaths.webRootPath, 'app.js'));

    const result = await doctorSessionDeckIterm2Install({
      homeDirectory,
      platform: 'darwin',
      runtimePaths,
      scriptsDir: join(homeDirectory, 'custom-scripts'),
    });

    expect(result.level).toBe('warning');
    expect(result.message).toContain('Session Deck iTerm2 doctor');
    expect(result.message).toContain(
      `Requested scripts dir ${join(homeDirectory, 'custom-scripts')} does not match manifest ownership ${scriptsDir}.`,
    );
    expect(result.message).toContain(
      `Web app is missing: ${join(runtimePaths.webRootPath, 'app.js')}`,
    );
    expect(result.message).toContain(
      'Installed AutoLaunch script differs from the current package template. Reinstall recommended.',
    );
    expect(result.message).toContain(
      '- manual: enable iTerm2 Python API if needed, then restart iTerm2 after install changes.',
    );

    expect(await readFile(scriptPath, 'utf8')).toBe('# drifted script\n');
  });

  it.each([
    ['malformed JSON', '{'],
    ['invalid shape', JSON.stringify({ schemaVersion: 1 })],
  ])('doctor and uninstall recover safely when the manifest has %s', async (_label, payload) => {
    const homeDirectory = await createTempHome();
    const runtimePaths = await createRuntimePaths(join(homeDirectory, 'package-root'));
    const manifestPath = getSessionDeckIterm2ManifestPath(homeDirectory);
    const scriptsDir = join(homeDirectory, 'Library', 'Application Support', 'iTerm2', 'Scripts');
    const scriptPath = getSessionDeckIterm2ScriptPath(scriptsDir);

    await mkdir(dirname(manifestPath), { recursive: true });
    await mkdir(dirname(scriptPath), { recursive: true });
    await writeFile(manifestPath, payload, 'utf8');
    await writeFile(scriptPath, '# sentinel script\n', 'utf8');

    const doctorResult = await doctorSessionDeckIterm2Install({
      homeDirectory,
      platform: 'darwin',
      runtimePaths,
    });

    expect(doctorResult.level).toBe('warning');
    expect(doctorResult.message).toContain(`- manifest: invalid (${manifestPath})`);
    expect(doctorResult.message).toContain(`Install manifest at ${manifestPath} could not be read`);
    expect(doctorResult.message).toContain('Manual recovery required');
    expect(doctorResult.message).toContain(
      'verify/remove any Session Deck AutoLaunch script manually',
    );

    const uninstallResult = await uninstallSessionDeckIterm2({ homeDirectory });

    expect(uninstallResult.level).toBe('warning');
    expect(uninstallResult.message).toContain(
      'Could not uninstall Session Deck iTerm2 Toolbelt automatically.',
    );
    expect(uninstallResult.message).toContain(
      `Install manifest at ${manifestPath} could not be read`,
    );
    expect(uninstallResult.message).toContain(
      'Nothing was removed because script ownership could not be verified.',
    );

    expect(await readFile(scriptPath, 'utf8')).toBe('# sentinel script\n');
    expect(await readFile(manifestPath, 'utf8')).toBe(payload);
  });

  it('uninstall removes manifest-owned artifacts, ignores mismatched --scripts-dir, and warns on second uninstall', async () => {
    const homeDirectory = await createTempHome();
    const runtimePaths = await createRuntimePaths(join(homeDirectory, 'package-root'));
    const scriptsDir = join(homeDirectory, 'Library', 'Application Support', 'iTerm2', 'Scripts');
    const manifestPath = getSessionDeckIterm2ManifestPath(homeDirectory);
    const scriptPath = getSessionDeckIterm2ScriptPath(scriptsDir);
    const decoyScriptsDir = join(homeDirectory, 'custom-scripts');
    const decoyScriptPath = getSessionDeckIterm2ScriptPath(decoyScriptsDir);

    await installSessionDeckIterm2({
      homeDirectory,
      now: () => new Date('2026-07-10T12:00:00.000Z'),
      platform: 'darwin',
      runtimePaths,
      scriptsDir,
    });
    await mkdir(dirname(decoyScriptPath), { recursive: true });
    await writeFile(decoyScriptPath, '# decoy script\n', 'utf8');

    const result = await uninstallSessionDeckIterm2({
      homeDirectory,
      scriptsDir: decoyScriptsDir,
    });

    expect(result.level).toBe('info');
    expect(result.message).toContain('Uninstalled Session Deck iTerm2 Toolbelt.');
    expect(result.message).toContain(
      `Ignored --scripts-dir ${decoyScriptsDir} because manifest ownership is ${scriptsDir}.`,
    );
    expect(result.message).toContain(`Removed script: ${scriptPath}`);
    expect(result.message).toContain(`Removed manifest: ${manifestPath}`);
    await expectPathMissing(scriptPath);
    await expectPathMissing(manifestPath);
    expect(await readFile(decoyScriptPath, 'utf8')).toBe('# decoy script\n');

    const secondResult = await uninstallSessionDeckIterm2({ homeDirectory });

    expect(secondResult).toEqual({
      level: 'warning',
      message: `No Session Deck iTerm2 install manifest found at ${manifestPath}.`,
    });
  });
});

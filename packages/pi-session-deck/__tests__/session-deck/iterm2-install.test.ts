import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  hashSessionDeckIterm2Content,
  readSessionDeckIterm2InstallState,
  SESSION_DECK_ITERM2_PRODUCT,
} from '../../extensions/session-deck/iterm2/state.js';
import {
  doctorSessionDeckIterm2Install,
  pingSessionDeckIterm2Bridge,
  type SessionDeckIterm2ExecutableStatus,
  type SessionDeckIterm2LiveLaunchPrereqResult,
} from '../../extensions/session-deck/iterm2/doctor.js';
import { installSessionDeckIterm2 } from '../../extensions/session-deck/iterm2/install.js';
import { uninstallSessionDeckIterm2 } from '../../extensions/session-deck/iterm2/uninstall.js';
import {
  getSessionDeckIterm2ScriptPath,
  getSessionDeckIterm2StatePath,
  type SessionDeckIterm2RuntimePaths,
} from '../../extensions/session-deck/iterm2/paths.js';

const tempDirectories: string[] = [];
const servers: net.Server[] = [];

const AUTOLAUNCH_SOURCE = Buffer.from(
  '#!/usr/bin/env python3\n# canonical runtime fixture\ndef run():\n    pass\n\nif __name__ == "__main__":\n    run()\n',
);

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
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
  options: { includeAppJs?: boolean; includeSource?: boolean } = {},
): Promise<SessionDeckIterm2RuntimePaths> {
  const snapshotHelperPath = join(
    root,
    'dist',
    'extensions',
    'session-deck',
    'iterm2',
    'snapshot-cli.js',
  );
  const createWorktreeHelperScriptPath = join(
    root,
    'dist',
    'extensions',
    'session-deck',
    'worktree',
    'action-cli.js',
  );
  const openTerminalHelperScriptPath = join(
    root,
    'dist',
    'extensions',
    'session-deck',
    'iterm2',
    'open-action-cli.js',
  );
  const killSessionHelperScriptPath = join(
    root,
    'dist',
    'extensions',
    'session-deck',
    'iterm2',
    'kill-action-cli.js',
  );
  const webRootPath = join(root, 'extensions', 'session-deck', 'iterm2', 'web');
  const autolaunchSourcePath = join(root, 'extensions', 'session-deck', 'iterm2', 'autolaunch.py');
  const socketRoot = await mkdtemp('/tmp/psd-iterm2-sock-');
  tempDirectories.push(socketRoot);
  const bridgeSocketPath = join(socketRoot, 'iterm2.sock');

  await mkdir(dirname(snapshotHelperPath), { recursive: true });
  await mkdir(dirname(createWorktreeHelperScriptPath), { recursive: true });
  await mkdir(dirname(openTerminalHelperScriptPath), { recursive: true });
  await mkdir(dirname(killSessionHelperScriptPath), { recursive: true });
  await mkdir(webRootPath, { recursive: true });
  await mkdir(dirname(autolaunchSourcePath), { recursive: true });
  await writeFile(snapshotHelperPath, 'console.log("snapshot")\n', 'utf8');
  await writeFile(createWorktreeHelperScriptPath, 'console.log("action")\n', 'utf8');
  await writeFile(openTerminalHelperScriptPath, 'console.log("open")\n', 'utf8');
  await writeFile(killSessionHelperScriptPath, 'console.log("kill")\n', 'utf8');
  await writeFile(join(webRootPath, 'index.html'), '<!doctype html>\n', 'utf8');
  if (options.includeAppJs !== false) {
    await writeFile(join(webRootPath, 'app.js'), 'console.log("app")\n', 'utf8');
  }
  await writeFile(
    join(webRootPath, 'launch-context-view.js'),
    'export const labels = []\n',
    'utf8',
  );
  await writeFile(join(webRootPath, 'style.css'), 'body{}\n', 'utf8');
  if (options.includeSource !== false) {
    await writeFile(autolaunchSourcePath, AUTOLAUNCH_SOURCE);
  }

  return {
    packageRoot: root,
    packageVersion: '1.2.3',
    nodeExecutablePath: '/runtime/node/bin/node',
    snapshotHelperPath,
    createWorktreeHelperScriptPath,
    openTerminalHelperScriptPath,
    killSessionHelperScriptPath,
    webRootPath,
    autolaunchSourcePath,
    bridgeSocketPath,
  };
}

async function createPingServer(socketPath: string): Promise<void> {
  await mkdir(dirname(socketPath), { recursive: true });
  const server = net.createServer((socket) => {
    socket.setEncoding('utf8');
    socket.on('data', () => {
      socket.write(`${JSON.stringify({ ok: true })}\n`);
      socket.end();
    });
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
}

function availableExecutable(path: string): SessionDeckIterm2ExecutableStatus {
  return { status: 'available', path };
}

function missingExecutable(): SessionDeckIterm2ExecutableStatus {
  return { status: 'missing' };
}

function makeLiveLaunchPrereqs(
  tmux: SessionDeckIterm2ExecutableStatus,
  pi: SessionDeckIterm2ExecutableStatus,
  pathProvenance: string = 'configured user shell at runtime',
): SessionDeckIterm2LiveLaunchPrereqResult {
  return {
    status: 'live',
    report: {
      pathProvenance,
      tmux,
      pi,
    },
  };
}

describe('session-deck iterm2 install + doctor + uninstall', () => {
  it('copies the canonical AutoLaunch source byte-for-byte and writes strict private v1 state', async () => {
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
    const statePath = getSessionDeckIterm2StatePath(homeDirectory);
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
    expect(result.message).toContain(`AutoLaunch script: ${expectedScriptPath}`);
    expect(result.message).toContain(`State: ${statePath}`);
    expect(result.message).toContain(`Bridge socket: ${runtimePaths.bridgeSocketPath}`);

    await expect(readFile(expectedScriptPath)).resolves.toEqual(AUTOLAUNCH_SOURCE);
    const state = await readSessionDeckIterm2InstallState(statePath);
    expect(state).toEqual({
      schemaVersion: 1,
      product: SESSION_DECK_ITERM2_PRODUCT,
      packageVersion: '1.2.3',
      installedAt: '2026-07-10T12:00:00.000Z',
      scriptsDir: expectedScriptsDir,
      script: {
        path: expectedScriptPath,
        sha256: hashSessionDeckIterm2Content(AUTOLAUNCH_SOURCE),
      },
      runtime: {
        nodeExecutablePath: runtimePaths.nodeExecutablePath,
        snapshotHelperPath: runtimePaths.snapshotHelperPath,
        webRootPath: runtimePaths.webRootPath,
        bridgeSocketPath: runtimePaths.bridgeSocketPath,
      },
    });
    const rawState = await readFile(statePath, 'utf8');
    expect(rawState).not.toContain('"PATH"');
    expect(rawState).not.toContain('tmuxExecutablePath');
    expect(rawState).not.toContain('piExecutablePath');
    expect((await stat(dirname(statePath))).mode & 0o777).toBe(0o700);
    expect((await stat(statePath)).mode & 0o777).toBe(0o600);
    expect((await stat(expectedScriptPath)).mode & 0o777).toBe(0o755);
  });

  it('refuses to overwrite an existing target that is not owned by valid state', async () => {
    const homeDirectory = await createTempHome();
    const runtimePaths = await createRuntimePaths(join(homeDirectory, 'package-root'));
    const scriptsDir = join(homeDirectory, 'Library', 'Application Support', 'iTerm2', 'Scripts');
    const scriptPath = getSessionDeckIterm2ScriptPath(scriptsDir);

    await mkdir(dirname(scriptPath), { recursive: true });
    await writeFile(scriptPath, '# unknown script\n', 'utf8');

    const result = await installSessionDeckIterm2({
      homeDirectory,
      platform: 'darwin',
      runtimePaths,
      scriptsDir,
    });

    expect(result.level).toBe('error');
    expect(result.message).toContain('AutoLaunch target already exists and is not owned');
    expect(await readFile(scriptPath, 'utf8')).toBe('# unknown script\n');
    await expectPathMissing(getSessionDeckIterm2StatePath(homeDirectory));
  });

  it('fails install when the canonical AutoLaunch source is missing', async () => {
    const homeDirectory = await createTempHome();
    const runtimePaths = await createRuntimePaths(join(homeDirectory, 'package-root'), {
      includeSource: false,
    });

    const result = await installSessionDeckIterm2({
      homeDirectory,
      platform: 'darwin',
      runtimePaths,
    });

    expect(result).toEqual({
      level: 'error',
      message: `iTerm2 AutoLaunch source not found: ${runtimePaths.autolaunchSourcePath}\nRun \`pnpm --dir packages/pi-session-deck run build\` and try again.`,
    });
  });

  it('fails install when the open-terminal helper artifact is missing', async () => {
    const homeDirectory = await createTempHome();
    const runtimePaths = await createRuntimePaths(join(homeDirectory, 'package-root'));
    await rm(runtimePaths.openTerminalHelperScriptPath);

    const result = await installSessionDeckIterm2({
      homeDirectory,
      platform: 'darwin',
      runtimePaths,
    });

    expect(result).toEqual({
      level: 'error',
      message: `Open-terminal helper not found: ${runtimePaths.openTerminalHelperScriptPath}\nRun \`pnpm --dir packages/pi-session-deck run build\` and try again.`,
    });
  });

  it('fails install when the kill-session helper artifact is missing', async () => {
    const homeDirectory = await createTempHome();
    const runtimePaths = await createRuntimePaths(join(homeDirectory, 'package-root'));
    await rm(runtimePaths.killSessionHelperScriptPath);

    const result = await installSessionDeckIterm2({
      homeDirectory,
      platform: 'darwin',
      runtimePaths,
    });

    expect(result).toEqual({
      level: 'error',
      message: `Kill-session helper not found: ${runtimePaths.killSessionHelperScriptPath}\nRun \`pnpm --dir packages/pi-session-deck run build\` and try again.`,
    });
  });

  it('fails install when the launch-context web helper is missing', async () => {
    const homeDirectory = await createTempHome();
    const runtimePaths = await createRuntimePaths(join(homeDirectory, 'package-root'));
    await rm(join(runtimePaths.webRootPath, 'launch-context-view.js'));

    const result = await installSessionDeckIterm2({
      homeDirectory,
      platform: 'darwin',
      runtimePaths,
    });

    expect(result).toEqual({
      level: 'error',
      message: `Web launch-context view helper not found: ${join(runtimePaths.webRootPath, 'launch-context-view.js')}\nRun \`pnpm --dir packages/pi-session-deck run build\` and try again.`,
    });
  });

  it('rolls back a newly written AutoLaunch script when state write fails', async () => {
    const homeDirectory = await createTempHome();
    const runtimePaths = await createRuntimePaths(join(homeDirectory, 'package-root'));
    const scriptsDir = join(homeDirectory, 'Library', 'Application Support', 'iTerm2', 'Scripts');
    const scriptPath = getSessionDeckIterm2ScriptPath(scriptsDir);
    const statePath = join(scriptPath, 'install.json');

    const result = await installSessionDeckIterm2({
      homeDirectory,
      platform: 'darwin',
      runtimePaths,
      scriptsDir,
      statePath,
    });

    expect(result.level).toBe('error');
    expect(result.message).toContain('Could not install Session Deck iTerm2 Toolbelt.');
    expect(result.message).toContain(`Install state at ${statePath} could not be written`);
    expect(result.message).toContain(`Rolled back newly written AutoLaunch script: ${scriptPath}`);
    await expectPathMissing(scriptPath);
  });

  it('doctor is read-only and reports state, source, asset, script hash, and socket problems', async () => {
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
    await writeFile(runtimePaths.autolaunchSourcePath, '# drifted source\n', 'utf8');
    await rm(runtimePaths.openTerminalHelperScriptPath);
    await rm(join(runtimePaths.webRootPath, 'app.js'));

    const result = await doctorSessionDeckIterm2Install({
      homeDirectory,
      platform: 'darwin',
      readLiveLaunchPrereqs: async () =>
        makeLiveLaunchPrereqs(
          availableExecutable('/runtime/tmux/bin/tmux'),
          availableExecutable('/runtime/pi/bin/pi'),
        ),
      resolveExecutable: async (command) =>
        command === 'tmux'
          ? availableExecutable('/runtime/tmux/bin/tmux')
          : availableExecutable('/runtime/pi/bin/pi'),
      runtimePaths,
    });

    expect(result.level).toBe('warning');
    expect(result.message).toContain('Session Deck iTerm2 doctor');
    expect(result.message).toContain(
      'Installed AutoLaunch script hash differs from recorded state',
    );
    expect(result.message).toContain(
      'Canonical AutoLaunch source hash differs from recorded state',
    );
    expect(result.message).toContain(
      `Web app is missing: ${join(runtimePaths.webRootPath, 'app.js')}`,
    );
    expect(result.message).toContain(
      `Open-terminal helper is missing: ${runtimePaths.openTerminalHelperScriptPath}`,
    );
    expect(result.message).toContain(`Bridge socket is missing: ${runtimePaths.bridgeSocketPath}`);
    expect(result.message).toContain(
      '- launch prerequisites (local Pi doctor process PATH (context only)):',
    );
    expect(result.message).toContain('  - tmux: available (/runtime/tmux/bin/tmux)');
    expect(result.message).toContain('  - pi: available (/runtime/pi/bin/pi)');
    expect(result.message).toContain(
      '- launch prerequisites (effective PATH used by + New and tmux Open preflight): unavailable',
    );
    expect(result.message).toContain(
      'Installed files do not reload an already-running AutoLaunch process; fully quit and reopen iTerm2 after install changes, then rerun /session-deck iterm2 doctor.',
    );
    expect(result.message).toContain(
      '- manual: enable iTerm2 Python API if needed, then fully quit and reopen iTerm2 after install changes.',
    );
    expect(await readFile(scriptPath, 'utf8')).toBe('# drifted script\n');
  });

  it('doctor reports local context and authoritative live + New PATH provenance', async () => {
    const homeDirectory = await createTempHome();
    const runtimePaths = await createRuntimePaths(join(homeDirectory, 'package-root'));
    await createPingServer(runtimePaths.bridgeSocketPath);

    await installSessionDeckIterm2({
      homeDirectory,
      now: () => new Date('2026-07-10T12:00:00.000Z'),
      platform: 'darwin',
      runtimePaths,
    });

    const result = await doctorSessionDeckIterm2Install({
      homeDirectory,
      platform: 'darwin',
      readLiveLaunchPrereqs: async () =>
        makeLiveLaunchPrereqs(
          availableExecutable('/runtime/tmux/bin/tmux'),
          availableExecutable('/runtime/pi/bin/pi'),
          'configured user shell at runtime',
        ),
      resolveExecutable: async (command) =>
        command === 'tmux' ? availableExecutable('/runtime/tmux/bin/tmux') : missingExecutable(),
      runtimePaths,
    });

    expect(result.level).toBe('info');
    expect(result.message).toContain(`- bridge socket: ${runtimePaths.bridgeSocketPath} (live)`);
    expect(result.message).toContain(
      '- launch prerequisites (local Pi doctor process PATH (context only)):',
    );
    expect(result.message).toContain('  - tmux: available (/runtime/tmux/bin/tmux)');
    expect(result.message).toContain('  - pi: missing');
    expect(result.message).toContain(
      '- launch prerequisites (effective PATH used by + New and tmux Open preflight):',
    );
    expect(result.message).toContain('  - provenance: configured user shell at runtime');
    expect(result.message).toContain('  - tmux: available (/runtime/tmux/bin/tmux)');
    expect(result.message).toContain('  - pi: available (/runtime/pi/bin/pi)');
    const statePayload = await readFile(getSessionDeckIterm2StatePath(homeDirectory), 'utf8');
    expect(statePayload).not.toContain('/runtime/tmux/bin/tmux');
    expect(statePayload).not.toContain('/runtime/pi/bin/pi');
  });

  it('doctor reports unavailable live + New PATH with actionable restart guidance', async () => {
    const homeDirectory = await createTempHome();
    const runtimePaths = await createRuntimePaths(join(homeDirectory, 'package-root'));

    await installSessionDeckIterm2({
      homeDirectory,
      now: () => new Date('2026-07-10T12:00:00.000Z'),
      platform: 'darwin',
      runtimePaths,
    });

    const result = await doctorSessionDeckIterm2Install({
      homeDirectory,
      pingBridge: async () => ({ status: 'live', message: 'Bridge socket answered ping.' }),
      platform: 'darwin',
      readLiveLaunchPrereqs: async () => ({
        status: 'unavailable',
        message: 'live AutoLaunch launch-prerequisite report could not be queried.',
      }),
      resolveExecutable: async (command) =>
        command === 'tmux'
          ? availableExecutable('/runtime/tmux/bin/tmux')
          : availableExecutable('/runtime/pi/bin/pi'),
      runtimePaths,
    });

    expect(result.level).toBe('warning');
    expect(result.message).toContain(
      '- launch prerequisites (effective PATH used by + New and tmux Open preflight): unavailable',
    );
    expect(result.message).toContain(
      'live AutoLaunch launch-prerequisite report could not be queried.',
    );
    expect(result.message).toContain(
      'Installed files do not reload an already-running AutoLaunch process; fully quit and reopen iTerm2 after install changes, then rerun /session-deck iterm2 doctor.',
    );
    expect(result.message).not.toContain('  - provenance:');
  });

  it('ping liveness distinguishes a non-socket path from a live bridge socket', async () => {
    const homeDirectory = await createTempHome();
    const nonSocketPath = join(homeDirectory, 'not-a-socket');
    await writeFile(nonSocketPath, 'nope\n', 'utf8');

    await expect(pingSessionDeckIterm2Bridge(nonSocketPath)).resolves.toEqual({
      status: 'not-socket',
      message: `Bridge socket path exists but is not a socket: ${nonSocketPath}`,
    });

    const socketRoot = await mkdtemp('/tmp/psd-iterm2-live-');
    tempDirectories.push(socketRoot);
    const socketPath = join(socketRoot, 'live.sock');
    await createPingServer(socketPath);
    await expect(pingSessionDeckIterm2Bridge(socketPath)).resolves.toEqual({
      status: 'live',
      message: 'Bridge socket answered ping.',
    });
  });

  it.each([
    ['malformed JSON', '{'],
    ['legacy manifest shape', JSON.stringify({ schemaVersion: 1, generatedScriptPath: '/tmp/x' })],
    [
      'extra keys',
      JSON.stringify({
        schemaVersion: 1,
        product: SESSION_DECK_ITERM2_PRODUCT,
        packageVersion: '1.2.3',
        installedAt: '2026-07-10T12:00:00.000Z',
        scriptsDir: '/tmp/scripts',
        script: {
          path: '/tmp/scripts/AutoLaunch/session_deck.py',
          sha256: hashSessionDeckIterm2Content(AUTOLAUNCH_SOURCE),
        },
        runtime: {
          nodeExecutablePath: '/runtime/node/bin/node',
          snapshotHelperPath: '/tmp/snapshot-cli.js',
          webRootPath: '/tmp/web',
          bridgeSocketPath: '/tmp/iterm2.sock',
        },
        legacy: true,
      }),
    ],
    [
      'runtime PATH field',
      JSON.stringify({
        schemaVersion: 1,
        product: SESSION_DECK_ITERM2_PRODUCT,
        packageVersion: '1.2.3',
        installedAt: '2026-07-10T12:00:00.000Z',
        scriptsDir: '/tmp/scripts',
        script: {
          path: '/tmp/scripts/AutoLaunch/session_deck.py',
          sha256: hashSessionDeckIterm2Content(AUTOLAUNCH_SOURCE),
        },
        runtime: {
          nodeExecutablePath: '/runtime/node/bin/node',
          snapshotHelperPath: '/tmp/snapshot-cli.js',
          webRootPath: '/tmp/web',
          bridgeSocketPath: '/tmp/iterm2.sock',
          PATH: '/runtime/tools/bin:/usr/bin',
        },
      }),
    ],
    [
      'runtime tmuxExecutablePath field',
      JSON.stringify({
        schemaVersion: 1,
        product: SESSION_DECK_ITERM2_PRODUCT,
        packageVersion: '1.2.3',
        installedAt: '2026-07-10T12:00:00.000Z',
        scriptsDir: '/tmp/scripts',
        script: {
          path: '/tmp/scripts/AutoLaunch/session_deck.py',
          sha256: hashSessionDeckIterm2Content(AUTOLAUNCH_SOURCE),
        },
        runtime: {
          nodeExecutablePath: '/runtime/node/bin/node',
          snapshotHelperPath: '/tmp/snapshot-cli.js',
          webRootPath: '/tmp/web',
          bridgeSocketPath: '/tmp/iterm2.sock',
          tmuxExecutablePath: '/runtime/tmux/bin/tmux',
        },
      }),
    ],
    [
      'runtime piExecutablePath field',
      JSON.stringify({
        schemaVersion: 1,
        product: SESSION_DECK_ITERM2_PRODUCT,
        packageVersion: '1.2.3',
        installedAt: '2026-07-10T12:00:00.000Z',
        scriptsDir: '/tmp/scripts',
        script: {
          path: '/tmp/scripts/AutoLaunch/session_deck.py',
          sha256: hashSessionDeckIterm2Content(AUTOLAUNCH_SOURCE),
        },
        runtime: {
          nodeExecutablePath: '/runtime/node/bin/node',
          snapshotHelperPath: '/tmp/snapshot-cli.js',
          webRootPath: '/tmp/web',
          bridgeSocketPath: '/tmp/iterm2.sock',
          piExecutablePath: '/runtime/pi/bin/pi',
        },
      }),
    ],
  ])('doctor and uninstall delete nothing when state has %s', async (_label, payload) => {
    const homeDirectory = await createTempHome();
    const runtimePaths = await createRuntimePaths(join(homeDirectory, 'package-root'));
    const statePath = getSessionDeckIterm2StatePath(homeDirectory);
    const scriptsDir = join(homeDirectory, 'Library', 'Application Support', 'iTerm2', 'Scripts');
    const scriptPath = getSessionDeckIterm2ScriptPath(scriptsDir);

    await mkdir(dirname(statePath), { recursive: true });
    await mkdir(dirname(scriptPath), { recursive: true });
    await writeFile(statePath, payload, 'utf8');
    await writeFile(scriptPath, '# sentinel script\n', 'utf8');

    const doctorResult = await doctorSessionDeckIterm2Install({
      homeDirectory,
      platform: 'darwin',
      runtimePaths,
    });

    expect(doctorResult.level).toBe('warning');
    expect(doctorResult.message).toContain(`- state: invalid (${statePath})`);
    expect(doctorResult.message).toContain(`Install state at ${statePath} could not be read`);
    expect(doctorResult.message).toContain('Manual recovery required');

    const uninstallResult = await uninstallSessionDeckIterm2({ homeDirectory });

    expect(uninstallResult.level).toBe('warning');
    expect(uninstallResult.message).toContain(
      'Could not uninstall Session Deck iTerm2 Toolbelt automatically.',
    );
    expect(uninstallResult.message).toContain(`Install state at ${statePath} could not be read`);
    expect(uninstallResult.message).toContain(
      'Nothing was removed because script ownership could not be verified.',
    );

    expect(await readFile(scriptPath, 'utf8')).toBe('# sentinel script\n');
    expect(await readFile(statePath, 'utf8')).toBe(payload);
  });

  it('uninstall deletes nothing when state script path does not match its scripts dir', async () => {
    const homeDirectory = await createTempHome();
    const statePath = getSessionDeckIterm2StatePath(homeDirectory);
    const scriptsDir = join(homeDirectory, 'Library', 'Application Support', 'iTerm2', 'Scripts');
    const expectedScriptPath = getSessionDeckIterm2ScriptPath(scriptsDir);
    const arbitraryScriptPath = join(homeDirectory, 'other.py');
    const payload = JSON.stringify({
      schemaVersion: 1,
      product: SESSION_DECK_ITERM2_PRODUCT,
      packageVersion: '1.2.3',
      installedAt: '2026-07-10T12:00:00.000Z',
      scriptsDir,
      script: {
        path: arbitraryScriptPath,
        sha256: hashSessionDeckIterm2Content(AUTOLAUNCH_SOURCE),
      },
      runtime: {
        nodeExecutablePath: '/runtime/node/bin/node',
        snapshotHelperPath: '/tmp/snapshot-cli.js',
        webRootPath: '/tmp/web',
        bridgeSocketPath: '/tmp/iterm2.sock',
      },
    });

    await mkdir(dirname(statePath), { recursive: true });
    await mkdir(dirname(expectedScriptPath), { recursive: true });
    await writeFile(statePath, payload, 'utf8');
    await writeFile(expectedScriptPath, '# expected script\n', 'utf8');
    await writeFile(arbitraryScriptPath, '# arbitrary script\n', 'utf8');

    const result = await uninstallSessionDeckIterm2({ homeDirectory });

    expect(result.level).toBe('warning');
    expect(result.message).toContain(`Install state at ${statePath} could not be read`);
    expect(await readFile(expectedScriptPath, 'utf8')).toBe('# expected script\n');
    expect(await readFile(arbitraryScriptPath, 'utf8')).toBe('# arbitrary script\n');
    expect(await readFile(statePath, 'utf8')).toBe(payload);
  });

  it('uninstall removes the state-owned script even when it drifted and leaves unrelated files alone', async () => {
    const homeDirectory = await createTempHome();
    const runtimePaths = await createRuntimePaths(join(homeDirectory, 'package-root'));
    const scriptsDir = join(homeDirectory, 'Library', 'Application Support', 'iTerm2', 'Scripts');
    const statePath = getSessionDeckIterm2StatePath(homeDirectory);
    const scriptPath = getSessionDeckIterm2ScriptPath(scriptsDir);
    const decoyScriptPath = getSessionDeckIterm2ScriptPath(join(homeDirectory, 'custom-scripts'));

    await installSessionDeckIterm2({
      homeDirectory,
      now: () => new Date('2026-07-10T12:00:00.000Z'),
      platform: 'darwin',
      runtimePaths,
      scriptsDir,
    });
    await writeFile(scriptPath, '# drifted but owned\n', 'utf8');
    await mkdir(dirname(decoyScriptPath), { recursive: true });
    await writeFile(decoyScriptPath, '# decoy script\n', 'utf8');

    const result = await uninstallSessionDeckIterm2({ homeDirectory });

    expect(result.level).toBe('info');
    expect(result.message).toContain('Uninstalled Session Deck iTerm2 Toolbelt.');
    expect(result.message).toContain(`Removed AutoLaunch script: ${scriptPath}`);
    expect(result.message).toContain(`Removed state: ${statePath}`);
    expect(result.message).toContain('Restart iTerm2 to stop any already-running');
    await expectPathMissing(scriptPath);
    await expectPathMissing(statePath);
    expect(await readFile(decoyScriptPath, 'utf8')).toBe('# decoy script\n');

    const secondResult = await uninstallSessionDeckIterm2({ homeDirectory });

    expect(secondResult).toEqual({
      level: 'warning',
      message: `No Session Deck iTerm2 install state found at ${statePath}.`,
    });
  });
});

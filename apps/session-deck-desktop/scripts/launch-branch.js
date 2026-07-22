#!/usr/bin/env node
/* global process, console */
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { access, chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DESKTOP_ROOT = resolve(SCRIPT_DIR, '..');
const REPO_ROOT = resolve(DESKTOP_ROOT, '../..');
const PACKAGE_NAME = '@robhowley/pi-session-deck';
const PACKAGE_ROOT = resolve(REPO_ROOT, 'packages/pi-session-deck');
const DESKTOP_FILTER = './apps/session-deck-desktop';
const APP_BUNDLE_NAME = 'Session Deck Desktop.app';
const APP_BUNDLE_PATH = resolve(
  DESKTOP_ROOT,
  `src-tauri/target/release/bundle/macos/${APP_BUNDLE_NAME}`,
);
const DEV_APP_PATH = resolve(DESKTOP_ROOT, 'src-tauri/target/debug/pi-session-deck-desktop');
const INSTALLED_APP_PATH = join(homedir(), 'Applications', APP_BUNDLE_NAME);
const INSTALLED_STATE_PATH = join(homedir(), '.pi/session-deck/desktop/install.json');
const STATE_ENV = 'PI_SESSION_DECK_DESKTOP_STATE_PATH';

/**
 * @typedef {'dev' | 'bundle'} LaunchMode
 *
 * @typedef {{
 *   mode: LaunchMode,
 *   openBundle: boolean,
 *   help: boolean,
 * }} LaunchOptions
 *
 * @typedef {{ code: number }} CommandResult
 *
 * @typedef {{
 *   cwd: string,
 *   env?: NodeJS.ProcessEnv,
 *   label: string,
 *   allowFailure?: boolean,
 * }} RunOptions
 *
 * @typedef {{ level: string, message: string }} CommandMessage
 */

/**
 * @param {string[]} argv
 * @returns {Promise<number>}
 */
async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(usage());
    return 0;
  }

  const [branch, version] = await Promise.all([branchSummary(), packageVersion()]);

  console.log('Session Deck Desktop branch launcher');
  console.log(`branch: ${branch}`);
  console.log(`packageRoot: ${PACKAGE_ROOT}`);
  console.log(`packageVersion: ${version}`);
  console.log('');

  await run('pnpm', ['--filter', PACKAGE_NAME, 'build'], {
    cwd: REPO_ROOT,
    label: `build ${PACKAGE_NAME}`,
  });

  return options.mode === 'bundle' ? bundleMode(options) : devMode(version);
}

/**
 * @param {string[]} argv
 * @returns {LaunchOptions}
 */
function parseArgs(argv) {
  /** @type {LaunchOptions} */
  const options = { mode: 'dev', openBundle: true, help: false };
  for (const arg of argv) {
    switch (arg) {
      case '-h':
      case '--help':
        options.help = true;
        break;
      case 'dev':
      case '--dev':
      case '--mode=dev':
        options.mode = 'dev';
        break;
      case 'bundle':
      case 'app-bundle':
      case 'release':
      case '--bundle':
      case '--mode=bundle':
      case '--mode=app-bundle':
      case '--mode=release':
        options.mode = 'bundle';
        break;
      case '--no-open':
        options.openBundle = false;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}\n${usage()}`);
    }
  }
  return options;
}

function usage() {
  return [
    'Usage: pnpm --filter ./apps/session-deck-desktop launch:branch [dev]',
    '       pnpm --filter ./apps/session-deck-desktop launch:branch bundle [--no-open]',
    '',
    'Default dev mode builds @robhowley/pi-session-deck, writes temporary branch runtime',
    'metadata, and runs the local Tauri dev app. Bundle mode builds bundle:macos,',
    'installs the .app with branch package metadata, and opens it unless --no-open is set.',
  ].join('\n');
}

/**
 * @param {string} version
 * @returns {Promise<number>}
 */
async function devMode(version) {
  const statePath = await writeBranchState(version);
  const command = ['--filter', DESKTOP_FILTER, 'dev'];

  console.log('mode: dev');
  console.log(`statePath: ${statePath}`);
  console.log(`stateEnv: ${STATE_ENV}=${statePath}`);
  console.log(`devApp: ${DEV_APP_PATH}`);
  console.log(`command: ${formatCommand('pnpm', command)}`);
  console.log('stop: press Ctrl-C in this terminal to stop the Tauri dev process.');
  console.log('');

  const result = await run('pnpm', command, {
    cwd: REPO_ROOT,
    env: { ...process.env, [STATE_ENV]: statePath },
    label: 'launch Tauri dev app',
  });
  return result.code;
}

/**
 * @param {LaunchOptions} options
 * @returns {Promise<number>}
 */
async function bundleMode(options) {
  if (process.platform !== 'darwin') {
    console.error(`Bundle mode is only supported on macOS, not ${process.platform}.`);
    return 1;
  }

  console.log('mode: bundle');
  console.log(`appBundle: ${APP_BUNDLE_PATH}`);
  console.log(`installedApp: ${INSTALLED_APP_PATH}`);
  console.log(`installedState: ${INSTALLED_STATE_PATH}`);
  console.log('');

  const bundle = await run('pnpm', ['--filter', DESKTOP_FILTER, 'bundle:macos'], {
    cwd: REPO_ROOT,
    label: 'build macOS app bundle',
    allowFailure: true,
  });
  if (bundle.code !== 0) {
    if (!(await exists(APP_BUNDLE_PATH))) {
      console.error(`bundle:macos failed and no app bundle was found at ${APP_BUNDLE_PATH}.`);
      return bundle.code;
    }
    console.warn(`bundle:macos exited ${bundle.code}; continuing because the .app exists.`);
  }

  const { installSessionDeckDesktop } = await importDist('desktop/install.js');
  const install = await installSessionDeckDesktop({ fromPath: APP_BUNDLE_PATH });
  printResult('install', install);
  if (install.level === 'error') {
    return 1;
  }

  console.log(`packageRoot: ${PACKAGE_ROOT}`);
  console.log(`appPath: ${INSTALLED_APP_PATH}`);
  console.log(`statePath: ${INSTALLED_STATE_PATH}`);
  console.log(
    'signing: this branch bundle is unsigned; macOS Gatekeeper/AMFI may quit it after Launch Services opens it. Dev mode avoids that.',
  );

  if (!options.openBundle) {
    console.log('open: skipped (--no-open).');
    return 0;
  }

  const { openSessionDeckDesktop } = await importDist('desktop/open.js');
  const opened = await openSessionDeckDesktop({});
  printResult('open', opened);
  return opened.level === 'error' ? 1 : 0;
}

/**
 * @param {string} relativePath
 * @returns {Promise<any>}
 */
async function importDist(relativePath) {
  return import(
    pathToFileURL(resolve(PACKAGE_ROOT, 'dist/extensions/session-deck', relativePath)).href
  );
}

/**
 * @param {string} version
 * @returns {Promise<string>}
 */
async function writeBranchState(version) {
  const dir = join(
    tmpdir(),
    `session-deck-desktop-branch-launcher-${process.getuid?.() ?? 'user'}`,
  );
  const file = `${hash(REPO_ROOT).slice(0, 16)}.install.json`;
  const path = join(dir, file);
  const tempPath = join(dir, `.${file}.${process.pid}.${randomUUID()}.tmp`);
  const state = {
    schemaVersion: 1,
    product: 'session-deck-desktop',
    packageName: PACKAGE_NAME,
    packageVersion: version,
    installedAt: new Date().toISOString(),
    runtime: {
      nodeExecutablePath: process.execPath,
      packageRoot: PACKAGE_ROOT,
      helperPackageVersion: version,
    },
  };

  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700);
    await writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    await chmod(tempPath, 0o600);
    await rename(tempPath, path);
    await chmod(path, 0o600);
    return path;
  } catch (error) {
    throw new Error(`Could not write branch runtime state at ${path}: ${message(error)}`);
  }
}

async function branchSummary() {
  const [branch, head] = await Promise.all([
    capture('git', ['branch', '--show-current']),
    capture('git', ['rev-parse', '--short', 'HEAD']),
  ]);
  if (branch !== null && branch.length > 0) {
    return head === null ? branch : `${branch} (${head})`;
  }
  return head === null ? 'unknown' : `detached (${head})`;
}

async function packageVersion() {
  const path = resolve(PACKAGE_ROOT, 'package.json');
  const packageJson = JSON.parse(await readFile(path, 'utf8'));
  if (typeof packageJson.version !== 'string' || packageJson.version.trim().length === 0) {
    throw new Error(`Could not determine package version from ${path}.`);
  }
  return packageJson.version;
}

/**
 * @param {string} command
 * @param {string[]} args
 * @param {RunOptions} options
 * @returns {Promise<CommandResult>}
 */
async function run(command, args, options) {
  console.log(`$ ${formatCommand(command, args)}`);
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: 'inherit',
    });
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (signal !== null) {
        if (options.allowFailure === true) {
          resolvePromise({ code: 1 });
          return;
        }
        reject(new Error(`${options.label} stopped after signal ${signal}.`));
        return;
      }
      const exitCode = code ?? 1;
      if (exitCode !== 0 && options.allowFailure !== true) {
        reject(new Error(`${options.label} failed with exit code ${exitCode}.`));
        return;
      }
      resolvePromise({ code: exitCode });
    });
  });
}

/**
 * @param {string} command
 * @param {string[]} args
 * @returns {Promise<string | null>}
 */
async function capture(command, args) {
  return new Promise((resolvePromise) => {
    let stdout = '';
    const child = spawn(command, args, { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'ignore'] });
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.on('error', () => resolvePromise(null));
    child.on('exit', (code) => {
      const output = stdout.trim();
      resolvePromise(code === 0 && output.length > 0 ? output : null);
    });
  });
}

/**
 * @param {string} path
 * @returns {Promise<boolean>}
 */
async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {string} text
 * @returns {string}
 */
function hash(text) {
  return createHash('sha256').update(text).digest('hex');
}

/**
 * @param {string} command
 * @param {string[]} args
 * @returns {string}
 */
function formatCommand(command, args) {
  return [command, ...args.map(quoteArg)].join(' ');
}

/**
 * @param {string} arg
 * @returns {string}
 */
function quoteArg(arg) {
  return /^[A-Za-z0-9_./:=@-]+$/u.test(arg) ? arg : JSON.stringify(arg);
}

/**
 * @param {string} label
 * @param {CommandMessage} result
 * @returns {void}
 */
function printResult(label, result) {
  const text = `${label}: ${result.message}`;
  if (result.level === 'error') {
    console.error(text);
  } else if (result.level === 'warning') {
    console.warn(text);
  } else {
    console.log(text);
  }
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function message(error) {
  return error instanceof Error ? error.message : String(error);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = await main();
  } catch (error) {
    console.error(message(error));
    process.exitCode = 1;
  }
}

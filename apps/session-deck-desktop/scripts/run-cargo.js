#!/usr/bin/env node
/* global process */
import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(SCRIPT_DIR, '..');

/**
 * @param {NodeJS.ProcessEnv} env
 * @param {string} homeDirectory
 * @returns {Promise<{ cargoPath: string, env: NodeJS.ProcessEnv }>}
 */
export async function buildCargoExecutionContext(env = process.env, homeDirectory = homedir()) {
  const cargoHomeBin = join(homeDirectory, '.cargo', 'bin');
  const cargoPath =
    (await findExecutableOnPath('cargo', env['PATH'])) ??
    ((await isExecutable(join(cargoHomeBin, 'cargo'))) ? join(cargoHomeBin, 'cargo') : null);

  if (cargoPath === null) {
    throw new Error(
      'Could not find cargo. Install Rust with rustup and ensure cargo is available.',
    );
  }

  return {
    cargoPath,
    env: {
      ...env,
      PATH: prependPathEntry(env['PATH'], cargoHomeBin),
    },
  };
}

/**
 * @param {string[]} argv
 * @returns {Promise<number>}
 */
export async function runCargo(argv = process.argv.slice(2)) {
  const { cargoPath, env } = await buildCargoExecutionContext();
  return await new Promise((resolve, reject) => {
    const child = spawn(cargoPath, argv, {
      cwd: PACKAGE_ROOT,
      env,
      stdio: 'inherit',
    });

    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (signal !== null) {
        reject(new Error(`cargo exited from signal ${signal}`));
        return;
      }
      resolve(code ?? 1);
    });
  });
}

/**
 * @param {string | undefined} currentPath
 * @param {string} entry
 * @returns {string}
 */
function prependPathEntry(currentPath, entry) {
  if (typeof currentPath !== 'string' || currentPath.length === 0) {
    return entry;
  }

  const entries = currentPath.split(delimiter);
  return entries.includes(entry) ? currentPath : [entry, ...entries].join(delimiter);
}

/**
 * @param {string} command
 * @param {string | undefined} currentPath
 * @returns {Promise<string | null>}
 */
async function findExecutableOnPath(command, currentPath) {
  if (typeof currentPath !== 'string' || currentPath.length === 0) {
    return null;
  }

  for (const entry of currentPath.split(delimiter)) {
    if (entry.length === 0) {
      continue;
    }

    const candidate = join(entry, command);
    if (await isExecutable(candidate)) {
      return candidate;
    }
  }

  return null;
}

/**
 * @param {string} path
 * @returns {Promise<boolean>}
 */
async function isExecutable(path) {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runCargo();
}

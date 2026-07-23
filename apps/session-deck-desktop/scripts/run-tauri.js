#!/usr/bin/env node
/* global process */
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildCargoExecutionContext } from './run-cargo.js';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(SCRIPT_DIR, '..');

/**
 * @param {string[]} argv
 * @returns {Promise<number>}
 */
export async function runTauri(argv = process.argv.slice(2)) {
  const { env } = await buildCargoExecutionContext();
  return await new Promise((resolve, reject) => {
    const child = spawn('pnpm', ['exec', 'tauri', ...argv], {
      cwd: PACKAGE_ROOT,
      env,
      stdio: 'inherit',
    });

    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (signal !== null) {
        reject(new Error(`tauri exited from signal ${signal}`));
        return;
      }
      resolve(code ?? 1);
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runTauri();
}

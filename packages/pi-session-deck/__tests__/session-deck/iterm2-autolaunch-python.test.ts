import { execFile as execFileCallback } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const execFile = promisify(execFileCallback);
const testDirectory = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(testDirectory, '../..');
const pythonTestPath = join(
  packageRoot,
  '__tests__',
  'session-deck',
  'python',
  'test_iterm2_autolaunch.py',
);

describe('iTerm2 AutoLaunch Python runtime unittest', () => {
  it('is exercised by the package Vitest command', async () => {
    const { stdout, stderr } = await execFile(
      process.env['PYTHON'] ?? 'python3',
      ['-m', 'unittest', pythonTestPath],
      {
        cwd: packageRoot,
        env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
        timeout: 15_000,
      },
    );

    expect(`${stdout}\n${stderr}`).toContain('OK');
  }, 20_000);
});

import { constants as fsConstants } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  classifyExecFileFailure,
  resolveCmuxExecutable,
} from '../extensions/cmux-junction/cmux-runtime.mjs';

describe('shared cmux runtime boundary', () => {
  it('normalizes the bundled candidate and requires executable access', async () => {
    const executableAccess = vi.fn(async () => undefined);

    await expect(
      resolveCmuxExecutable({ CMUX_BUNDLED_CLI_PATH: '  /bundle/cmux  ' }, executableAccess),
    ).resolves.toBe('/bundle/cmux');
    expect(executableAccess).toHaveBeenCalledWith('/bundle/cmux', fsConstants.X_OK);
  });

  it('falls back when the candidate is absent or not executable', async () => {
    const executableAccess = vi.fn(async () => {
      throw new Error('not executable');
    });

    await expect(resolveCmuxExecutable({}, executableAccess)).resolves.toBe('cmux');
    await expect(
      resolveCmuxExecutable({ CMUX_BUNDLED_CLI_PATH: ' /missing ' }, executableAccess),
    ).resolves.toBe('cmux');
    expect(executableAccess).toHaveBeenCalledWith('/missing', fsConstants.X_OK);
  });

  it.each([
    [
      { killed: true, signal: null },
      { kind: 'timeout', signal: 'SIGTERM' },
    ],
    [
      { killed: false, signal: 'SIGKILL' },
      { kind: 'signal', signal: 'SIGKILL' },
    ],
    [
      { killed: false, signal: null, code: 7 },
      { kind: 'exit', exitCode: 7 },
    ],
    [
      { killed: false, signal: null, code: 'ENOENT', message: 'missing' },
      { kind: 'spawn', code: 'ENOENT', message: 'missing' },
    ],
  ])('classifies low-level execFile failure %#', (error, expected) => {
    expect(classifyExecFileFailure(error)).toEqual(expected);
  });
});

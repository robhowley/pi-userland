import { describe, expect, it } from 'vitest';
import { defaultProcessRunner } from '../extensions/cmux-junction/process.js';

const cwd = process.cwd();

describe('default process runner', () => {
  it('preserves a zero exit', async () => {
    await expect(
      defaultProcessRunner(process.execPath, ['-e', 'process.stdout.write("ok")'], { cwd }),
    ).resolves.toEqual({ outcome: 'exit', exitCode: 0, stdout: 'ok', stderr: '' });
  });

  it('preserves an ordinary nonzero exit', async () => {
    await expect(
      defaultProcessRunner(
        process.execPath,
        ['-e', 'process.stderr.write("bad"); process.exit(7)'],
        {
          cwd,
        },
      ),
    ).resolves.toEqual({ outcome: 'exit', exitCode: 7, stdout: '', stderr: 'bad' });
  });

  it('distinguishes timeout from the signal used to kill the child', async () => {
    await expect(
      defaultProcessRunner(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        cwd,
        timeoutMs: 50,
      }),
    ).resolves.toMatchObject({ outcome: 'timeout', timeoutMs: 50, signal: 'SIGTERM' });
  });

  it('preserves signal termination', async () => {
    await expect(
      defaultProcessRunner(process.execPath, ['-e', "process.kill(process.pid, 'SIGTERM')"], {
        cwd,
      }),
    ).resolves.toMatchObject({ outcome: 'signal', signal: 'SIGTERM' });
  });

  it('preserves spawn failure for a missing executable', async () => {
    await expect(
      defaultProcessRunner('pi-cmux-junction-definitely-missing-executable', [], { cwd }),
    ).resolves.toMatchObject({ outcome: 'spawn-failed', code: 'ENOENT' });
  });
});

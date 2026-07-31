import { describe, expect, it } from 'vitest';
import { readDescendantPids } from '../../extensions/session-deck/restart/process.js';

const ROOT_PID = 4100;

describe('restart process helper', () => {
  it('discovers grandchildren and deeper descendants recursively', async () => {
    await expect(
      readDescendantPids(ROOT_PID, async () => ({
        stdout: ['4101 4100', '4102 4101', '4103 4102', '9999 8888'].join('\n'),
        exitCode: 0,
      })),
    ).resolves.toEqual([4101, 4102, 4103]);
  });

  it('returns the root sentinel when ps inspection exits nonzero', async () => {
    await expect(
      readDescendantPids(ROOT_PID, async () => ({
        stdout: '4101 4100\n',
        exitCode: 1,
      })),
    ).resolves.toEqual([ROOT_PID]);
  });
});

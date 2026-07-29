import { describe, expect, it } from 'vitest';
import { createBranchState } from '../scripts/launch-branch.js';

describe('launch-branch development metadata', () => {
  it('uses the development discriminator without persisting derived helper paths', () => {
    const state = createBranchState('1.2.3', '2026-07-28T00:00:00.000Z');

    expect(state).toMatchObject({
      schemaVersion: 1,
      product: 'session-deck-desktop-development',
      packageName: '@robhowley/pi-session-deck',
      packageVersion: '1.2.3',
      installedAt: '2026-07-28T00:00:00.000Z',
      runtime: {
        nodeExecutablePath: process.execPath,
        helperPackageVersion: '1.2.3',
      },
    });
    expect(Object.keys(state.runtime).sort()).toEqual([
      'helperPackageVersion',
      'nodeExecutablePath',
      'packageRoot',
    ]);
    expect(state).not.toHaveProperty('app');
    expect(state).not.toHaveProperty('source');
    expect(state).not.toHaveProperty('ownedPaths');
  });
});

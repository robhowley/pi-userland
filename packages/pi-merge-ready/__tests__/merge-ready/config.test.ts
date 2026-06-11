import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { loadMergeReadyConfigAsync } from '../../extensions/merge-ready/config.js';

function writeJsonFile(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2), 'utf-8');
}

describe.sequential('loadMergeReadyConfigAsync', () => {
  let originalAgentDir: string | undefined;
  let testRoot: string;
  let cwd: string;
  let agentDir: string;

  beforeEach(() => {
    originalAgentDir = process.env['PI_CODING_AGENT_DIR'];
    testRoot = mkdtempSync(join(tmpdir(), 'pi-merge-ready-config-'));
    cwd = join(testRoot, 'repo');
    agentDir = join(testRoot, 'agent');
    mkdirSync(cwd, { recursive: true });
    process.env['PI_CODING_AGENT_DIR'] = agentDir;
  });

  afterEach(() => {
    if (originalAgentDir === undefined) {
      delete process.env['PI_CODING_AGENT_DIR'];
    } else {
      process.env['PI_CODING_AGENT_DIR'] = originalAgentDir;
    }

    rmSync(testRoot, { recursive: true, force: true });
  });

  function writeGlobalSettings(settings: unknown) {
    writeJsonFile(join(agentDir, 'settings.json'), settings);
  }

  function writeProjectSettings(settings: unknown) {
    writeJsonFile(join(cwd, '.pi', 'settings.json'), settings);
  }

  it('lets project false override global true', async () => {
    writeGlobalSettings({
      'pi-merge-ready': {
        autoCompactRepair: true,
      },
    });
    writeProjectSettings({
      'pi-merge-ready': {
        autoCompactRepair: false,
      },
    });

    await expect(loadMergeReadyConfigAsync(cwd)).resolves.toEqual({
      autoCompactRepair: false,
    });
  });

  it('lets project true override global false', async () => {
    writeGlobalSettings({
      'pi-merge-ready': {
        autoCompactRepair: false,
      },
    });
    writeProjectSettings({
      'pi-merge-ready': {
        autoCompactRepair: true,
      },
    });

    await expect(loadMergeReadyConfigAsync(cwd)).resolves.toEqual({
      autoCompactRepair: true,
    });
  });

  it('defaults to true when settings are absent', async () => {
    await expect(loadMergeReadyConfigAsync(cwd)).resolves.toEqual({
      autoCompactRepair: true,
    });
  });

  it('defaults to true when the project setting is invalid', async () => {
    writeGlobalSettings({
      'pi-merge-ready': {
        autoCompactRepair: false,
      },
    });
    writeProjectSettings({
      'pi-merge-ready': {
        autoCompactRepair: 'invalid',
      },
    });

    await expect(loadMergeReadyConfigAsync(cwd)).resolves.toEqual({
      autoCompactRepair: true,
    });
  });
});

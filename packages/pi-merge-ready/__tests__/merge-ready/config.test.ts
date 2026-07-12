import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { loadMergeReadyConfigAsync } from '../../extensions/merge-ready/config.js';

function writeJsonFile(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2), 'utf-8');
}

const DEFAULT_CONFIG = {
  autoCompactRepair: true,
  cacheTTLSeconds: 60,
  enableStatusBarDiagnostics: false,
  repairGuidance: {},
};

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

  it('lets trusted project settings override scalar fields and layer repair guidance additively', async () => {
    writeGlobalSettings({
      'pi-merge-ready': {
        autoCompactRepair: true,
        cacheTTLSeconds: 90,
        enableStatusBarDiagnostics: false,
        repairGuidance: {
          ci_failing: 'Run the focused vitest file first.',
          unresolved_conversations: 'Track the thread links before responding manually.',
        },
      },
    });
    writeProjectSettings({
      'pi-merge-ready': {
        autoCompactRepair: false,
        cacheTTLSeconds: 5,
        enableStatusBarDiagnostics: true,
        repairGuidance: {
          ci_failing:
            'Start with pnpm --filter @robhowley/pi-merge-ready test -- __tests__/merge-ready/watch.test.ts',
          merge_conflicts: 'Rebase onto main before touching unrelated files.',
        },
      },
    });

    await expect(loadMergeReadyConfigAsync(cwd, true)).resolves.toEqual({
      autoCompactRepair: false,
      cacheTTLSeconds: 5,
      enableStatusBarDiagnostics: true,
      repairGuidance: {
        ci_failing:
          'Start with pnpm --filter @robhowley/pi-merge-ready test -- __tests__/merge-ready/watch.test.ts',
        unresolved_conversations: 'Track the thread links before responding manually.',
        merge_conflicts: 'Rebase onto main before touching unrelated files.',
      },
    });
  });

  it('defaults when settings are absent', async () => {
    await expect(loadMergeReadyConfigAsync(cwd)).resolves.toEqual(DEFAULT_CONFIG);
  });

  it('defaults to ignoring project settings when trust is unspecified', async () => {
    writeGlobalSettings({
      'pi-merge-ready': {
        autoCompactRepair: false,
        cacheTTLSeconds: 30,
        enableStatusBarDiagnostics: false,
        repairGuidance: {
          ci_failing: 'Run the package tests first.',
        },
      },
    });
    writeProjectSettings({
      'pi-merge-ready': {
        autoCompactRepair: true,
        cacheTTLSeconds: 5,
        enableStatusBarDiagnostics: true,
        repairGuidance: {
          merge_conflicts: 'Project guidance should be ignored when trust is unspecified.',
        },
      },
    });

    await expect(loadMergeReadyConfigAsync(cwd)).resolves.toEqual({
      autoCompactRepair: false,
      cacheTTLSeconds: 30,
      enableStatusBarDiagnostics: false,
      repairGuidance: {
        ci_failing: 'Run the package tests first.',
      },
    });
  });

  it('falls back per scalar field when project values are invalid', async () => {
    writeGlobalSettings({
      'pi-merge-ready': {
        autoCompactRepair: false,
        cacheTTLSeconds: 45,
        enableStatusBarDiagnostics: false,
        repairGuidance: {
          ci_failing: 'Keep the valid global guidance.',
        },
      },
    });
    writeProjectSettings({
      'pi-merge-ready': {
        autoCompactRepair: 'invalid',
        cacheTTLSeconds: 0,
        enableStatusBarDiagnostics: 'invalid',
      },
    });

    await expect(loadMergeReadyConfigAsync(cwd, true)).resolves.toEqual({
      autoCompactRepair: false,
      cacheTTLSeconds: 45,
      enableStatusBarDiagnostics: false,
      repairGuidance: {
        ci_failing: 'Keep the valid global guidance.',
      },
    });
  });

  it('ignores project settings when untrusted', async () => {
    writeGlobalSettings({
      'pi-merge-ready': {
        autoCompactRepair: false,
        cacheTTLSeconds: 30,
        enableStatusBarDiagnostics: false,
        repairGuidance: {
          ci_failing: 'Keep the global prompt.',
        },
      },
    });
    writeProjectSettings({
      'pi-merge-ready': {
        autoCompactRepair: true,
        cacheTTLSeconds: 5,
        enableStatusBarDiagnostics: true,
        repairGuidance: {
          merge_conflicts: 'Ignored in untrusted projects.',
        },
      },
    });

    await expect(loadMergeReadyConfigAsync(cwd, false)).resolves.toEqual({
      autoCompactRepair: false,
      cacheTTLSeconds: 30,
      enableStatusBarDiagnostics: false,
      repairGuidance: {
        ci_failing: 'Keep the global prompt.',
      },
    });
  });

  it('enables diagnostics from settings without env overrides', async () => {
    writeGlobalSettings({
      'pi-merge-ready': {
        enableStatusBarDiagnostics: true,
      },
    });

    await expect(loadMergeReadyConfigAsync(cwd, true)).resolves.toEqual({
      ...DEFAULT_CONFIG,
      enableStatusBarDiagnostics: true,
    });
  });

  it('ignores invalid repair guidance roots', async () => {
    writeGlobalSettings({
      'pi-merge-ready': {
        repairGuidance: ['ci_failing'],
      },
    });

    await expect(loadMergeReadyConfigAsync(cwd, true)).resolves.toEqual(DEFAULT_CONFIG);
  });

  it('ignores invalid repair guidance keys', async () => {
    writeGlobalSettings({
      'pi-merge-ready': {
        repairGuidance: {
          ci_failing: 'Keep this canonical key.',
          checks_failing: 'Ignore this alias.',
        },
      },
    });

    await expect(loadMergeReadyConfigAsync(cwd, true)).resolves.toEqual({
      ...DEFAULT_CONFIG,
      repairGuidance: {
        ci_failing: 'Keep this canonical key.',
      },
    });
  });

  it('ignores invalid repair guidance values', async () => {
    writeGlobalSettings({
      'pi-merge-ready': {
        repairGuidance: {
          ci_failing: 'Keep this string.',
          merge_conflicts: false,
        },
      },
    });

    await expect(loadMergeReadyConfigAsync(cwd, true)).resolves.toEqual({
      ...DEFAULT_CONFIG,
      repairGuidance: {
        ci_failing: 'Keep this string.',
      },
    });
  });

  it('ignores blank repair guidance strings after trimming', async () => {
    writeGlobalSettings({
      'pi-merge-ready': {
        repairGuidance: {
          ci_failing: '   ',
          merge_conflicts: '  Rebase and resolve only the reported conflicts.  ',
        },
      },
    });

    await expect(loadMergeReadyConfigAsync(cwd, true)).resolves.toEqual({
      ...DEFAULT_CONFIG,
      repairGuidance: {
        merge_conflicts: 'Rebase and resolve only the reported conflicts.',
      },
    });
  });

  it('does not let invalid project guidance erase valid global guidance', async () => {
    writeGlobalSettings({
      'pi-merge-ready': {
        repairGuidance: {
          ci_failing: 'Keep this global fallback.',
        },
      },
    });
    writeProjectSettings({
      'pi-merge-ready': {
        repairGuidance: {
          ci_failing: '   ',
          merge_conflicts: false,
        },
      },
    });

    await expect(loadMergeReadyConfigAsync(cwd, true)).resolves.toEqual({
      ...DEFAULT_CONFIG,
      repairGuidance: {
        ci_failing: 'Keep this global fallback.',
      },
    });
  });
});

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { isStatusEnabled, loadOpenRouterConfig } from '../config.js';

function writeJsonFile(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2), 'utf-8');
}

describe.sequential('openrouter config', () => {
  let originalAgentDir: string | undefined;
  let testRoot: string;
  let cwd: string;
  let agentDir: string;

  beforeEach(() => {
    originalAgentDir = process.env['PI_CODING_AGENT_DIR'];
    testRoot = mkdtempSync(join(tmpdir(), 'pi-openrouter-config-'));
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

  it('defaults statusEnabled to true when settings are absent', () => {
    expect(loadOpenRouterConfig(cwd)).toEqual({
      statusEnabled: true,
    });
    expect(isStatusEnabled(cwd)).toBe(true);
  });

  it('lets a global false disable status', () => {
    writeGlobalSettings({
      'pi-openrouter': {
        statusEnabled: false,
      },
    });

    expect(loadOpenRouterConfig(cwd)).toEqual({
      statusEnabled: false,
    });
    expect(isStatusEnabled(cwd)).toBe(false);
  });

  it('lets project false override global true', () => {
    writeGlobalSettings({
      'pi-openrouter': {
        statusEnabled: true,
      },
    });
    writeProjectSettings({
      'pi-openrouter': {
        statusEnabled: false,
      },
    });

    expect(loadOpenRouterConfig(cwd)).toEqual({
      statusEnabled: false,
    });
  });

  it('lets project true override global false', () => {
    writeGlobalSettings({
      'pi-openrouter': {
        statusEnabled: false,
      },
    });
    writeProjectSettings({
      'pi-openrouter': {
        statusEnabled: true,
      },
    });

    expect(loadOpenRouterConfig(cwd)).toEqual({
      statusEnabled: true,
    });
  });

  it('defaults invalid or unset values to true', () => {
    writeGlobalSettings({
      'pi-openrouter': {
        statusEnabled: false,
      },
    });
    writeProjectSettings({
      'pi-openrouter': {
        statusEnabled: 'invalid',
      },
    });

    expect(loadOpenRouterConfig(cwd)).toEqual({
      statusEnabled: true,
    });

    writeProjectSettings({});
    writeGlobalSettings({
      'pi-openrouter': 'invalid',
    });

    expect(loadOpenRouterConfig(cwd)).toEqual({
      statusEnabled: true,
    });
  });

  it('ignores project-local overrides when the project is untrusted', () => {
    writeGlobalSettings({
      'pi-openrouter': {
        statusEnabled: true,
      },
    });
    writeProjectSettings({
      'pi-openrouter': {
        statusEnabled: false,
      },
    });

    expect(loadOpenRouterConfig(cwd, false)).toEqual({
      statusEnabled: true,
    });
    expect(isStatusEnabled(cwd, false)).toBe(true);
  });
});

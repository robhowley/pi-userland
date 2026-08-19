import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { loadJunctionConfig } from '../extensions/cmux-junction/config.js';

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value), 'utf8');
}

describe.sequential('junction config', () => {
  let originalAgentDir: string | undefined;
  let root: string;
  let cwd: string;
  let agentDir: string;

  beforeEach(() => {
    originalAgentDir = process.env['PI_CODING_AGENT_DIR'];
    root = mkdtempSync(join(tmpdir(), 'pi-cmux-junction-config-'));
    cwd = join(root, 'repo');
    agentDir = join(root, 'agent');
    mkdirSync(cwd, { recursive: true });
    process.env['PI_CODING_AGENT_DIR'] = agentDir;
  });

  afterEach(() => {
    if (originalAgentDir === undefined) {
      delete process.env['PI_CODING_AGENT_DIR'];
    } else {
      process.env['PI_CODING_AGENT_DIR'] = originalAgentDir;
    }
    rmSync(root, { recursive: true, force: true });
  });

  const globalSettingsPath = () => join(agentDir, 'settings.json');
  const projectSettingsPath = () => join(cwd, '.pi', 'settings.json');

  it('defaults disableStatus to false', () => {
    expect(loadJunctionConfig(cwd, true)).toEqual({ disableStatus: false });
  });

  it.each([true, false])('loads global disableStatus=%s', (disableStatus) => {
    writeJson(globalSettingsPath(), { 'pi-cmux-junction': { disableStatus } });

    expect(loadJunctionConfig(cwd, true)).toEqual({ disableStatus });
  });

  it.each([
    { global: true, project: false },
    { global: false, project: true },
  ])('lets trusted project $project override global $global', ({ global, project }) => {
    writeJson(globalSettingsPath(), {
      'pi-cmux-junction': { disableStatus: global },
    });
    writeJson(projectSettingsPath(), {
      'pi-cmux-junction': { disableStatus: project },
    });

    expect(loadJunctionConfig(cwd, true)).toEqual({ disableStatus: project });
  });

  it('does not read or apply an untrusted project setting', () => {
    writeJson(globalSettingsPath(), {
      'pi-cmux-junction': { disableStatus: false },
    });
    writeJson(projectSettingsPath(), {
      'pi-cmux-junction': { disableStatus: true },
    });

    expect(loadJunctionConfig(cwd, false)).toEqual({ disableStatus: false });
  });

  it.each([
    { 'pi-cmux-junction': { disableStatus: 'true' } },
    { 'pi-cmux-junction': 'malformed' },
    { 'pi-cmux-junction': [] },
  ])('falls back to global for an invalid or malformed project scope', (project) => {
    writeJson(globalSettingsPath(), {
      'pi-cmux-junction': { disableStatus: true },
    });
    writeJson(projectSettingsPath(), project);

    expect(loadJunctionConfig(cwd, true)).toEqual({ disableStatus: true });
  });

  it('falls back to global when project settings JSON is malformed', () => {
    writeJson(globalSettingsPath(), {
      'pi-cmux-junction': { disableStatus: true },
    });
    mkdirSync(dirname(projectSettingsPath()), { recursive: true });
    writeFileSync(projectSettingsPath(), '{', 'utf8');

    expect(loadJunctionConfig(cwd, true)).toEqual({ disableStatus: true });
  });

  it.each([{ 'pi-cmux-junction': { disableStatus: 1 } }, { 'pi-cmux-junction': null }, []])(
    'falls back to false for an invalid or malformed global scope',
    (global) => {
      writeJson(globalSettingsPath(), global);

      expect(loadJunctionConfig(cwd, true)).toEqual({ disableStatus: false });
    },
  );

  it('falls back to false when global settings JSON is malformed', () => {
    mkdirSync(dirname(globalSettingsPath()), { recursive: true });
    writeFileSync(globalSettingsPath(), '{', 'utf8');

    expect(loadJunctionConfig(cwd, true)).toEqual({ disableStatus: false });
  });
});

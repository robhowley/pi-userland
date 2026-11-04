import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadRemembrancerConfig } from '../extensions/remembrancer/config.js';

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value), 'utf8');
}

describe.sequential('remembrancer config', () => {
  let originalAgentDir: string | undefined;
  let root: string;
  let cwd: string;
  let agentDir: string;

  beforeEach(() => {
    originalAgentDir = process.env['PI_CODING_AGENT_DIR'];
    root = mkdtempSync(join(tmpdir(), 'pi-remembrancer-config-'));
    cwd = join(root, 'repo');
    agentDir = join(root, 'agent');
    mkdirSync(cwd, { recursive: true });
    process.env['PI_CODING_AGENT_DIR'] = agentDir;
  });

  afterEach(() => {
    if (originalAgentDir === undefined) delete process.env['PI_CODING_AGENT_DIR'];
    else process.env['PI_CODING_AGENT_DIR'] = originalAgentDir;
    rmSync(root, { recursive: true, force: true });
  });

  const globalSettingsPath = () => join(agentDir, 'settings.json');
  const projectSettingsPath = () => join(cwd, '.pi', 'settings.json');

  it('defaults to enabled', () => {
    expect(loadRemembrancerConfig(cwd, true)).toEqual({ disabled: false });
  });

  it.each([true, false])('loads global disabled=%s from the active agent directory', (disabled) => {
    writeJson(globalSettingsPath(), { 'pi-remembrancer': { disabled } });

    expect(loadRemembrancerConfig(cwd, true).disabled).toBe(disabled);
  });

  it.each([
    { global: true, project: false },
    { global: false, project: true },
  ])('lets a trusted project setting override global settings', ({ global, project }) => {
    writeJson(globalSettingsPath(), { 'pi-remembrancer': { disabled: global } });
    writeJson(projectSettingsPath(), { 'pi-remembrancer': { disabled: project } });

    expect(loadRemembrancerConfig(cwd, true).disabled).toBe(project);
  });

  it('ignores a project setting when the project is untrusted', () => {
    writeJson(globalSettingsPath(), { 'pi-remembrancer': { disabled: false } });
    writeJson(projectSettingsPath(), { 'pi-remembrancer': { disabled: true } });

    expect(loadRemembrancerConfig(cwd, false).disabled).toBe(false);
  });

  it.each([
    { 'pi-remembrancer': { disabled: 'true' } },
    { 'pi-remembrancer': 'malformed' },
    { 'pi-remembrancer': [] },
  ])('falls back to global for an invalid project scope', (project) => {
    writeJson(globalSettingsPath(), { 'pi-remembrancer': { disabled: true } });
    writeJson(projectSettingsPath(), project);

    expect(loadRemembrancerConfig(cwd, true).disabled).toBe(true);
  });

  it('falls back to global when project settings JSON is malformed', () => {
    writeJson(globalSettingsPath(), { 'pi-remembrancer': { disabled: true } });
    mkdirSync(dirname(projectSettingsPath()), { recursive: true });
    writeFileSync(projectSettingsPath(), '{', 'utf8');

    expect(loadRemembrancerConfig(cwd, true).disabled).toBe(true);
  });

  it.each([
    { 'pi-remembrancer': { disabled: 1 } },
    { 'pi-remembrancer': null },
    { 'pi-remembrancer': [] },
    { is_disabled: true, isDisabled: true },
  ])('falls back to enabled for an invalid global scope', (global) => {
    writeJson(globalSettingsPath(), global);

    expect(loadRemembrancerConfig(cwd, true).disabled).toBe(false);
  });

  it('falls back to enabled when global settings JSON is malformed', () => {
    mkdirSync(dirname(globalSettingsPath()), { recursive: true });
    writeFileSync(globalSettingsPath(), '{', 'utf8');

    expect(loadRemembrancerConfig(cwd, true).disabled).toBe(false);
  });
});

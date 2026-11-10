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

  it('defaults to enabled with automatic capture off', () => {
    expect(loadRemembrancerConfig(cwd, true)).toEqual({ disabled: false, autoCapture: false });
  });

  it.each([true, false])('loads global disabled=%s from the active agent directory', (disabled) => {
    writeJson(globalSettingsPath(), { 'pi-remembrancer': { disabled } });

    expect(loadRemembrancerConfig(cwd, true).disabled).toBe(disabled);
  });

  it.each([true, false])(
    'loads global autoCapture=%s from the active agent directory',
    (autoCapture) => {
      writeJson(globalSettingsPath(), { 'pi-remembrancer': { autoCapture } });

      expect(loadRemembrancerConfig(cwd, true).autoCapture).toBe(autoCapture);
    },
  );

  it('keeps automatic capture independent of disabled', () => {
    writeJson(globalSettingsPath(), { 'pi-remembrancer': { disabled: true, autoCapture: true } });

    expect(loadRemembrancerConfig(cwd, true)).toEqual({ disabled: true, autoCapture: true });
  });

  it.each([
    { setting: 'disabled' as const, global: true, project: false },
    { setting: 'disabled' as const, global: false, project: true },
    { setting: 'autoCapture' as const, global: true, project: false },
    { setting: 'autoCapture' as const, global: false, project: true },
  ])('lets a trusted project override $setting', ({ setting, global, project }) => {
    writeJson(globalSettingsPath(), { 'pi-remembrancer': { [setting]: global } });
    writeJson(projectSettingsPath(), { 'pi-remembrancer': { [setting]: project } });

    expect(loadRemembrancerConfig(cwd, true)[setting]).toBe(project);
  });

  it('ignores project settings when the project is untrusted', () => {
    writeJson(globalSettingsPath(), { 'pi-remembrancer': { disabled: false, autoCapture: false } });
    writeJson(projectSettingsPath(), { 'pi-remembrancer': { disabled: true, autoCapture: true } });

    expect(loadRemembrancerConfig(cwd, false)).toEqual({ disabled: false, autoCapture: false });
  });

  it.each([
    { setting: 'disabled' as const, project: { 'pi-remembrancer': { disabled: 'true' } } },
    { setting: 'autoCapture' as const, project: { 'pi-remembrancer': { autoCapture: 'true' } } },
    { setting: 'disabled' as const, project: { 'pi-remembrancer': 'malformed' } },
    { setting: 'autoCapture' as const, project: { 'pi-remembrancer': [] } },
  ])('falls back to global for an invalid project $setting value', ({ setting, project }) => {
    writeJson(globalSettingsPath(), { 'pi-remembrancer': { [setting]: true } });
    writeJson(projectSettingsPath(), project);

    expect(loadRemembrancerConfig(cwd, true)[setting]).toBe(true);
  });

  it('falls back to global when project settings JSON is malformed', () => {
    writeJson(globalSettingsPath(), { 'pi-remembrancer': { disabled: true, autoCapture: true } });
    mkdirSync(dirname(projectSettingsPath()), { recursive: true });
    writeFileSync(projectSettingsPath(), '{', 'utf8');

    expect(loadRemembrancerConfig(cwd, true)).toEqual({ disabled: true, autoCapture: true });
  });

  it.each([
    { setting: 'disabled' as const, global: { 'pi-remembrancer': { disabled: 1 } } },
    { setting: 'autoCapture' as const, global: { 'pi-remembrancer': { autoCapture: 'true' } } },
    { setting: 'disabled' as const, global: { 'pi-remembrancer': null } },
    { setting: 'autoCapture' as const, global: { 'pi-remembrancer': [] } },
    { setting: 'disabled' as const, global: { is_disabled: true, isDisabled: true } },
  ])('falls back to the default for an invalid global $setting value', ({ setting, global }) => {
    writeJson(globalSettingsPath(), global);

    expect(loadRemembrancerConfig(cwd, true)[setting]).toBe(false);
  });

  it('falls back to defaults when global settings JSON is malformed', () => {
    mkdirSync(dirname(globalSettingsPath()), { recursive: true });
    writeFileSync(globalSettingsPath(), '{', 'utf8');

    expect(loadRemembrancerConfig(cwd, true)).toEqual({ disabled: false, autoCapture: false });
  });
});

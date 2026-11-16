import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { captureExecution, loadRemembrancerConfig } from '../extensions/remembrancer/config.js';
import { preserveHandoff, type HandoffInput } from '../extensions/remembrancer/capture-handoff.js';

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

  it.each([true, false])('loads global autoCapture=%s without changing disabled', (autoCapture) => {
    writeJson(globalSettingsPath(), { 'pi-remembrancer': { autoCapture } });
    expect(loadRemembrancerConfig(cwd, true)).toEqual({ disabled: false, autoCapture });
  });

  it.each([true, false])('applies per-field project precedence only when trusted=%s', (trusted) => {
    writeJson(globalSettingsPath(), { 'pi-remembrancer': { autoCapture: true, disabled: true } });
    writeJson(projectSettingsPath(), { 'pi-remembrancer': { disabled: false } });
    expect(loadRemembrancerConfig(cwd, trusted)).toEqual({ disabled: !trusted, autoCapture: true });
    writeJson(projectSettingsPath(), { 'pi-remembrancer': { autoCapture: false } });
    expect(loadRemembrancerConfig(cwd, trusted)).toEqual({ disabled: true, autoCapture: !trusted });
  });

  it.each(['true', 1, null, [], {}])('ignores invalid autoCapture=%j per field', (autoCapture) => {
    writeJson(globalSettingsPath(), { 'pi-remembrancer': { autoCapture } });
    expect(loadRemembrancerConfig(cwd, true).autoCapture).toBe(false);
    writeJson(globalSettingsPath(), { 'pi-remembrancer': { autoCapture: true, disabled: true } });
    writeJson(projectSettingsPath(), { 'pi-remembrancer': { autoCapture, disabled: false } });
    expect(loadRemembrancerConfig(cwd, true)).toEqual({ disabled: false, autoCapture: true });
  });

  it('does not mutate settings files when reading capture configuration', () => {
    const global = { 'pi-remembrancer': { autoCapture: true } };
    const project = { 'pi-remembrancer': { disabled: true } };
    writeJson(globalSettingsPath(), global);
    writeJson(projectSettingsPath(), project);
    loadRemembrancerConfig(cwd, true);
    expect(readFileSync(globalSettingsPath(), 'utf8')).toBe(JSON.stringify(global));
    expect(readFileSync(projectSettingsPath(), 'utf8')).toBe(JSON.stringify(project));
  });

  const globalSettingsPath = () => join(agentDir, 'settings.json');
  const projectSettingsPath = () => join(cwd, '.pi', 'settings.json');

  it('captures one outgoing model and trust record without copying credentials or consulting saved trust', () => {
    const model = {
      provider: 'local',
      id: 'exact',
      api: 'openai-completions',
      baseUrl: 'http://127.0.0.1:1234/v1',
      headers: { Authorization: 'private-token' },
    };
    const execution = captureExecution({
      cwd,
      model,
      thinkingLevel: 'high',
      isProjectTrusted: () => true,
    } as unknown as ExtensionContext);
    expect(execution).toMatchObject({
      cwd,
      agentDir,
      runtime: { thinkingLevel: 'high', projectTrusted: true, model: { id: 'exact' } },
    });
    expect(JSON.stringify(execution)).not.toContain('private-token');
    expect(execution.runtime.model).not.toHaveProperty('headers');
    expect(execution).not.toHaveProperty('model');
    expect(execution).not.toHaveProperty('trustBasis');
    expect(execution).not.toHaveProperty('settings');
    expect(model.headers.Authorization).toBe('private-token');
    expect(execution.host!.nodeExecutable).toBe(process.execPath);
    expect(execution.host!.piEntry).toMatch(/\/dist\/cli\.js$/);
    expect(existsSync(join(agentDir, 'trust.json'))).toBe(false);
  });

  function handoff(): HandoffInput {
    const source = join(root, 'source.jsonl');
    writeFileSync(source, '{"type":"session","id":"session"}\n');
    return {
      id: 'admission',
      inbox: join(root, 'inbox'),
      source: { file: source, sessionId: 'session' },
      execution: captureExecution({
        cwd,
        thinkingLevel: 'high',
        isProjectTrusted: () => true,
        model: {
          provider: 'local',
          id: 'exact',
          name: 'Local model',
          api: 'openai-completions',
          baseUrl: 'http://127.0.0.1:1234/v1',
          reasoning: true,
          input: ['text'],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 32000,
          maxTokens: 1024,
        },
      } as unknown as ExtensionContext),
    };
  }

  it.each([
    'missing-runtime',
    'missing-model',
    'partial-model',
    'missing-thinking',
    'missing-trust',
    'outer-model',
    'settings-envelope',
  ])('rejects %s before creating any admission artifact', async (invalid) => {
    const input = handoff();
    const execution = input.execution as unknown as Record<string, unknown>;
    const runtime = input.execution.runtime as unknown as Record<string, unknown>;
    if (invalid === 'missing-runtime') delete execution['runtime'];
    if (invalid === 'missing-model') delete runtime['model'];
    if (invalid === 'partial-model') runtime['model'] = { provider: 'local', id: 'exact' };
    if (invalid === 'missing-thinking') delete runtime['thinkingLevel'];
    if (invalid === 'missing-trust') delete runtime['projectTrusted'];
    if (invalid === 'outer-model') execution['model'] = { provider: 'local', id: 'exact' };
    if (invalid === 'settings-envelope') execution['settings'] = { userFile: '/old/settings.json' };
    await expect(preserveHandoff(input)).rejects.toMatchObject({
      phase: 'validation',
      category: 'invalid-input',
    });
    expect(existsSync(input.inbox)).toBe(false);
  });

  it('accepts a complete runtime, retaining source extent, selected thinking, host and authorization', async () => {
    const input = handoff();
    const accepted = await preserveHandoff(input);
    expect(accepted.manifest).toMatchObject({
      version: 3,
      source: { ...input.source, bytes: Buffer.byteLength(readFileSync(input.source.file)) },
      execution: { ...input.execution, runtime: { thinkingLevel: 'high', projectTrusted: true } },
    });
    expect(accepted.manifest.execution).not.toHaveProperty('model');
    expect(accepted.manifest.execution).not.toHaveProperty('settings');
    expect(accepted.manifest.execution.runtime.model.id).toBe('exact');
  });

  it.each(['absent', 'wrong-model', 'wrong-provider'])(
    'rejects runtime-only header provenance (%s) before artifacts without resolving commands',
    async (configuration) => {
      const input = handoff();
      input.execution.runtime.headerNames = ['X-Required'];
      const marker = join(root, 'command-ran');
      writeJson(join(agentDir, 'models.json'), {
        providers: {
          [configuration === 'wrong-provider' ? 'other' : 'local']: {
            models: [
              {
                id: configuration === 'wrong-model' ? 'other' : 'exact',
                headers: configuration === 'absent' ? {} : { 'X-Required': `!touch ${marker}` },
              },
            ],
          },
        },
      });
      await expect(preserveHandoff(input)).rejects.toMatchObject({
        phase: 'validation',
        category: 'unsupported-runtime-headers',
      });
      expect(existsSync(input.inbox)).toBe(false);
      expect(existsSync(marker)).toBe(false);
    },
  );

  it.each(['provider', 'model', 'override'])(
    'admits case-insensitive persistent %s header references without resolving or saving values',
    async (scope) => {
      const input = handoff();
      input.execution.runtime.headerNames = ['X-Required'];
      const marker = join(root, 'command-ran');
      const headers = { 'x-required': `!touch ${marker}; printf SENTINEL-SECRET` };
      writeJson(join(agentDir, 'models.json'), {
        providers: {
          local: {
            ...(scope === 'provider' ? { headers } : {}),
            ...(scope === 'model' ? { models: [{ id: 'exact', headers }] } : {}),
            ...(scope === 'override' ? { modelOverrides: { exact: { headers } } } : {}),
          },
        },
      });
      const accepted = await preserveHandoff(input);
      const saved = readFileSync(accepted.ready, 'utf8');
      expect(saved).toContain('X-Required');
      expect(saved).not.toContain('SENTINEL-SECRET');
      expect(saved).not.toContain('touch');
      expect(existsSync(marker)).toBe(false);
    },
  );

  it('defaults to enabled', () => {
    expect(loadRemembrancerConfig(cwd, true)).toEqual({ disabled: false, autoCapture: false });
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

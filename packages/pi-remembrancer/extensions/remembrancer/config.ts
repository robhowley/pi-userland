import { join } from 'node:path';
import {
  getAgentDir,
  getPackageDir,
  SettingsManager,
  type ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import type { HandoffInput } from './capture-handoff.js';

export interface RemembrancerConfig {
  disabled: boolean;
  autoCapture: boolean;
}

export const DEFAULT_REMEMBRANCER_CONFIG: RemembrancerConfig = {
  disabled: false,
  autoCapture: false,
};

export function loadRemembrancerConfig(cwd: string, projectTrusted: boolean): RemembrancerConfig {
  const settings = SettingsManager.create(cwd, getAgentDir(), { projectTrusted });
  const project = projectTrusted ? remembrancerSettings(settings.getProjectSettings()) : {};
  const global = remembrancerSettings(settings.getGlobalSettings());
  const booleanSetting = (
    scope: Record<string, unknown>,
    name: keyof RemembrancerConfig,
  ): boolean | undefined => (typeof scope[name] === 'boolean' ? scope[name] : undefined);

  return {
    disabled:
      booleanSetting(project, 'disabled') ??
      booleanSetting(global, 'disabled') ??
      DEFAULT_REMEMBRANCER_CONFIG.disabled,
    autoCapture:
      booleanSetting(project, 'autoCapture') ??
      booleanSetting(global, 'autoCapture') ??
      DEFAULT_REMEMBRANCER_CONFIG.autoCapture,
  };
}

/** Capture non-secret execution data from the outgoing context, never from a later waking TUI. */
export function captureExecution(ctx: ExtensionContext): HandoffInput['execution'] {
  if (!ctx.model) throw Error('Capture requires the outgoing model');
  const model = structuredClone(ctx.model);
  delete model.headers;
  return {
    cwd: ctx.cwd,
    agentDir: getAgentDir(),
    trustBasis: ctx.isProjectTrusted()
      ? 'originating-context-trusted'
      : 'originating-context-untrusted',
    model: { provider: model.provider, id: model.id },
    authorization: { autoCapture: true, disabled: false },
    host: { nodeExecutable: process.execPath, piEntry: join(getPackageDir(), 'dist', 'cli.js') },
    runtime: {
      model,
      ...(ctx.model.headers ? { headerNames: Object.keys(ctx.model.headers) } : {}),
      thinkingLevel: ctx.thinkingLevel ?? 'medium',
      projectTrusted: ctx.isProjectTrusted(),
    },
  };
}

function remembrancerSettings(settings: unknown): Record<string, unknown> {
  if (!isRecord(settings)) return {};
  const remembrancer = settings['pi-remembrancer'];
  return isRecord(remembrancer) ? remembrancer : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

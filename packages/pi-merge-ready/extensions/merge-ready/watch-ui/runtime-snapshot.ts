import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Api, Model } from '@earendil-works/pi-ai';
import type { ModelRegistry } from '@earendil-works/pi-coding-agent';
import type { MergeReadyWatchUiPaths } from './supervisor-state.js';

export type MergeReadyWatchUiResolvedRuntimeAuth = {
  provider: string;
  apiKey?: string;
  headers?: Record<string, string>;
};

export type MergeReadyWatchUiThinkingLevel =
  | 'off'
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh';

export type WatchUiRuntimeModel = Model<Api>;
export type WatchUiRuntimeModelRegistry = Pick<ModelRegistry, 'getApiKeyAndHeaders'>;

export type MergeReadyWatchUiRuntimeSnapshot = {
  sdkVersion: string;
  agentDir: string;
  defaultCwd: string;
  model: WatchUiRuntimeModel;
  thinkingLevel: MergeReadyWatchUiThinkingLevel;
  auth: MergeReadyWatchUiResolvedRuntimeAuth;
  signature: string;
};

export type WatchUiResolvedRuntimeAuth = MergeReadyWatchUiResolvedRuntimeAuth;
export type WatchUiThinkingLevel = MergeReadyWatchUiThinkingLevel;
export type WatchUiRuntimeSnapshot = MergeReadyWatchUiRuntimeSnapshot;

export type MergeReadyWatchUiRuntimePaths = {
  authStoragePath: string;
  modelRegistryPath: string;
};

export type CaptureWatchUiRuntimeSnapshotOptions = {
  agentDir: string;
  defaultCwd: string;
  getThinkingLevel?: () => WatchUiThinkingLevel | undefined;
  model?: WatchUiRuntimeModel;
  modelRegistry?: WatchUiRuntimeModelRegistry;
  sdkVersion: string;
};

export class MergeReadyWatchUiRuntimePreflightError extends Error {
  constructor(message: string) {
    super(`Merge-ready watch UI runtime-preflight failed: ${message}`);
    this.name = 'MergeReadyWatchUiRuntimePreflightError';
  }
}

export function isMergeReadyWatchUiRuntimePreflightError(
  error: unknown,
): error is MergeReadyWatchUiRuntimePreflightError {
  return error instanceof MergeReadyWatchUiRuntimePreflightError;
}

export function getMergeReadyWatchUiRuntimePaths(agentDir: string): MergeReadyWatchUiRuntimePaths {
  return {
    authStoragePath: path.join(agentDir, 'auth.json'),
    modelRegistryPath: path.join(agentDir, 'models.json'),
  };
}

export async function captureWatchUiRuntimeSnapshot(
  options: CaptureWatchUiRuntimeSnapshotOptions,
): Promise<WatchUiRuntimeSnapshot> {
  if (!options.model) {
    throw new MergeReadyWatchUiRuntimePreflightError('missing active model.');
  }

  if (!options.modelRegistry) {
    throw new MergeReadyWatchUiRuntimePreflightError('missing active model registry.');
  }

  const thinkingLevel = options.getThinkingLevel?.();
  if (!thinkingLevel) {
    throw new MergeReadyWatchUiRuntimePreflightError('missing active thinking level.');
  }

  const resolvedAuth = await options.modelRegistry.getApiKeyAndHeaders(options.model);
  if (!resolvedAuth.ok) {
    throw new MergeReadyWatchUiRuntimePreflightError(
      `unable to resolve runtime auth for ${formatWatchUiModelLabel(options.model)}: ${resolvedAuth.error}`,
    );
  }

  const resolvedHeaders = normalizeHeaders(resolvedAuth.headers);
  const snapshotModel = structuredClone(options.model);
  if (resolvedHeaders) {
    snapshotModel.headers = resolvedHeaders;
  } else {
    delete snapshotModel.headers;
  }

  const unsignedSnapshot = normalizeWatchUiRuntimeSnapshot({
    sdkVersion: options.sdkVersion,
    agentDir: options.agentDir,
    defaultCwd: options.defaultCwd,
    model: snapshotModel,
    thinkingLevel,
    auth: {
      provider: snapshotModel.provider,
      ...(resolvedAuth.apiKey === undefined ? {} : { apiKey: resolvedAuth.apiKey }),
      ...(resolvedHeaders === undefined ? {} : { headers: resolvedHeaders }),
    },
    signature: 'pending-signature',
  });

  const signature = createWatchUiRuntimeSnapshotSignature(unsignedSnapshot);
  const snapshot = {
    ...unsignedSnapshot,
    signature,
  };

  assertMergeReadyWatchUiRuntimeSnapshot(snapshot);
  return snapshot;
}

export function createWatchUiRuntimeSnapshotSignature(
  snapshot: Omit<WatchUiRuntimeSnapshot, 'signature'> | WatchUiRuntimeSnapshot,
): string {
  const normalized = normalizeWatchUiRuntimeSnapshot({
    ...snapshot,
    signature: 'pending-signature',
  });
  const { signature, ...payload } = normalized;
  void signature;
  return createHash('sha256').update(stableStringify(payload)).digest('hex');
}

export async function writeWatchUiRuntimeSnapshotHandoff(
  paths: Pick<MergeReadyWatchUiPaths, 'stateDir'>,
  snapshot: WatchUiRuntimeSnapshot,
): Promise<string> {
  const normalized = normalizeWatchUiRuntimeSnapshot(snapshot);
  assertMergeReadyWatchUiRuntimeSnapshot(normalized);

  const expectedSignature = createWatchUiRuntimeSnapshotSignature(normalized);
  if (normalized.signature !== expectedSignature) {
    throw new MergeReadyWatchUiRuntimePreflightError(
      'runtime snapshot signature does not match the captured payload.',
    );
  }

  await mkdir(paths.stateDir, { recursive: true, mode: 0o700 });
  const handoffPath = path.join(
    paths.stateDir,
    `runtime-snapshot.${process.pid}.${Date.now()}.${randomBytes(6).toString('hex')}.json`,
  );
  await writeFile(handoffPath, `${JSON.stringify(normalized)}\n`, {
    flag: 'wx',
    mode: 0o600,
  });
  return handoffPath;
}

export async function readWatchUiRuntimeSnapshotHandoff(
  handoffPath: string,
  options: { expectedSdkVersion: string },
): Promise<WatchUiRuntimeSnapshot> {
  const content = await readFile(handoffPath, 'utf8');
  await removeWatchUiRuntimeSnapshotHandoff(handoffPath);

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new Error(
      `Unable to parse merge-ready watch UI runtime snapshot handoff ${handoffPath}: ${getErrorMessage(error)}`,
    );
  }

  assertMergeReadyWatchUiRuntimeSnapshot(parsed as WatchUiRuntimeSnapshot);
  const snapshot = normalizeWatchUiRuntimeSnapshot(parsed as WatchUiRuntimeSnapshot);

  if (snapshot.sdkVersion !== options.expectedSdkVersion) {
    throw new Error(
      `Merge-ready watch UI runtime snapshot SDK version mismatch: launcher=${snapshot.sdkVersion} supervisor=${options.expectedSdkVersion}.`,
    );
  }

  const expectedSignature = createWatchUiRuntimeSnapshotSignature(snapshot);
  if (snapshot.signature !== expectedSignature) {
    throw new Error(
      `Merge-ready watch UI runtime snapshot signature mismatch: expected ${expectedSignature} but received ${snapshot.signature}.`,
    );
  }

  return snapshot;
}

export async function removeWatchUiRuntimeSnapshotHandoff(handoffPath: string): Promise<void> {
  await rm(handoffPath, { force: true });
}

export function getMergeReadyWatchUiSnapshotModelHeaders(
  snapshot: MergeReadyWatchUiRuntimeSnapshot,
): Record<string, string> | undefined {
  const headers = snapshot.auth.headers ?? snapshot.model.headers;
  return normalizeHeaders(headers);
}

export function createMergeReadyWatchUiSnapshotModel(
  snapshot: MergeReadyWatchUiRuntimeSnapshot,
): Model<Api> {
  const headers = getMergeReadyWatchUiSnapshotModelHeaders(snapshot);
  return {
    ...snapshot.model,
    ...(headers === undefined ? {} : { headers }),
  };
}

export function assertMergeReadyWatchUiRuntimeSnapshot(
  snapshot: MergeReadyWatchUiRuntimeSnapshot,
): void {
  const snapshotRecord = asRecord(snapshot, 'runtime snapshot payload must be an object.');
  readRequiredString(snapshotRecord, 'sdkVersion', 'runtime snapshot is missing sdkVersion.');
  readRequiredString(snapshotRecord, 'agentDir', 'runtime snapshot is missing agentDir.');
  readRequiredString(snapshotRecord, 'defaultCwd', 'runtime snapshot is missing defaultCwd.');
  readRequiredString(snapshotRecord, 'signature', 'runtime snapshot is missing signature.');

  const thinkingLevel = readRequiredString(
    snapshotRecord,
    'thinkingLevel',
    'runtime snapshot is missing thinkingLevel.',
  );
  if (!WATCH_UI_THINKING_LEVELS.has(thinkingLevel as WatchUiThinkingLevel)) {
    throw new MergeReadyWatchUiRuntimePreflightError(
      `runtime snapshot thinkingLevel ${JSON.stringify(thinkingLevel)} is unsupported.`,
    );
  }

  const modelRecord = asRecord(snapshotRecord['model'], 'runtime snapshot is missing model.');
  readRequiredString(modelRecord, 'provider', 'runtime snapshot is missing model provider/id.');
  readRequiredString(modelRecord, 'id', 'runtime snapshot is missing model provider/id.');
  readRequiredString(modelRecord, 'name', 'runtime snapshot is missing model name.');
  readRequiredString(modelRecord, 'api', 'runtime snapshot is missing model api.');
  readRequiredString(modelRecord, 'baseUrl', 'runtime snapshot is missing model baseUrl.');

  if (typeof modelRecord['reasoning'] !== 'boolean') {
    throw new MergeReadyWatchUiRuntimePreflightError(
      'runtime snapshot is missing model reasoning support metadata.',
    );
  }

  if (
    !Array.isArray(modelRecord['input']) ||
    modelRecord['input'].some((value) => value !== 'text' && value !== 'image')
  ) {
    throw new MergeReadyWatchUiRuntimePreflightError(
      'runtime snapshot is missing model input modes.',
    );
  }

  const costRecord = asRecord(
    modelRecord['cost'],
    'runtime snapshot is missing model cost metadata.',
  );
  for (const field of ['input', 'output', 'cacheRead', 'cacheWrite'] as const) {
    const value = costRecord[field];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new MergeReadyWatchUiRuntimePreflightError(
        `runtime snapshot is missing model cost.${field}.`,
      );
    }
  }

  for (const field of ['contextWindow', 'maxTokens'] as const) {
    const value = modelRecord[field];
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      throw new MergeReadyWatchUiRuntimePreflightError(
        `runtime snapshot is missing model ${field}.`,
      );
    }
  }

  if (modelRecord['headers'] !== undefined) {
    assertStringRecord(
      modelRecord['headers'],
      'runtime snapshot model headers must be a string map.',
    );
  }

  const authRecord = asRecord(snapshotRecord['auth'], 'runtime snapshot is missing auth provider.');
  const authProvider = readRequiredString(
    authRecord,
    'provider',
    'runtime snapshot is missing auth provider.',
  );

  if (authRecord['headers'] !== undefined) {
    assertStringRecord(
      authRecord['headers'],
      'runtime snapshot auth headers must be a string map.',
    );
  }

  if (authRecord['apiKey'] !== undefined && typeof authRecord['apiKey'] !== 'string') {
    throw new MergeReadyWatchUiRuntimePreflightError(
      'runtime snapshot auth apiKey must be a string.',
    );
  }

  if (authProvider !== snapshot.model.provider) {
    throw new MergeReadyWatchUiRuntimePreflightError(
      `runtime snapshot auth provider ${JSON.stringify(authProvider)} does not match model provider ${JSON.stringify(snapshot.model.provider)}.`,
    );
  }

  const unresolvedApiKey = readUnresolvedRuntimeValue(snapshot.auth.apiKey);
  if (unresolvedApiKey) {
    throw new MergeReadyWatchUiRuntimePreflightError(
      `runtime snapshot auth apiKey still looks unresolved (${JSON.stringify(unresolvedApiKey)}).`,
    );
  }

  for (const [headerName, headerValue] of Object.entries(
    getMergeReadyWatchUiSnapshotModelHeaders(snapshot) ?? {},
  )) {
    const unresolvedHeader = readUnresolvedRuntimeValue(headerValue);
    if (unresolvedHeader) {
      throw new MergeReadyWatchUiRuntimePreflightError(
        `runtime snapshot header ${JSON.stringify(headerName)} still looks unresolved (${JSON.stringify(unresolvedHeader)}).`,
      );
    }
  }
}

function normalizeWatchUiRuntimeSnapshot(snapshot: WatchUiRuntimeSnapshot): WatchUiRuntimeSnapshot {
  const model = structuredClone(snapshot.model);
  const modelHeaders = normalizeHeaders(snapshot.model.headers);
  if (modelHeaders) {
    model.headers = modelHeaders;
  } else {
    delete model.headers;
  }

  const authHeaders = normalizeHeaders(snapshot.auth.headers);
  return {
    sdkVersion: snapshot.sdkVersion.trim(),
    agentDir: path.resolve(snapshot.agentDir),
    defaultCwd: path.resolve(snapshot.defaultCwd),
    model,
    thinkingLevel: snapshot.thinkingLevel,
    auth: {
      provider: snapshot.auth.provider.trim(),
      ...(snapshot.auth.apiKey === undefined ? {} : { apiKey: snapshot.auth.apiKey }),
      ...(authHeaders === undefined ? {} : { headers: authHeaders }),
    },
    signature: snapshot.signature.trim(),
  };
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortJsonValue(value));
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => sortJsonValue(entry));
  }

  if (typeof value !== 'object' || value === null) {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entryValue]) => [key, sortJsonValue(entryValue)]),
  );
}

function normalizeHeaders(
  headers: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!headers) {
    return undefined;
  }

  const entries = Object.entries(headers);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function asRecord(value: unknown, message: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new MergeReadyWatchUiRuntimePreflightError(message);
  }

  return value as Record<string, unknown>;
}

function readRequiredString(value: Record<string, unknown>, key: string, message: string): string {
  const raw = value[key];
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw new MergeReadyWatchUiRuntimePreflightError(message);
  }

  return raw.trim();
}

function assertStringRecord(
  value: unknown,
  message: string,
): asserts value is Record<string, string> {
  const record = asRecord(value, message);
  for (const headerValue of Object.values(record)) {
    if (typeof headerValue !== 'string') {
      throw new MergeReadyWatchUiRuntimePreflightError(message);
    }
  }
}

function readUnresolvedRuntimeValue(value: string | undefined): string | null {
  if (!value) {
    return null;
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }

  if (trimmed.startsWith('!')) {
    return trimmed;
  }

  if (/^\$\{[^}]+\}$/.test(trimmed) || /^\$[A-Za-z_][A-Za-z0-9_]*$/.test(trimmed)) {
    return trimmed;
  }

  return null;
}

function formatWatchUiModelLabel(model: Pick<WatchUiRuntimeModel, 'provider' | 'id'>): string {
  return `${model.provider}/${model.id}`;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const WATCH_UI_THINKING_LEVELS = new Set<WatchUiThinkingLevel>([
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
]);

import path from 'node:path';
import type { Api, Model } from '@earendil-works/pi-ai';

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

export type MergeReadyWatchUiRuntimeSnapshot = {
  sdkVersion?: string;
  agentDir: string;
  defaultCwd: string;
  model: Model<Api>;
  thinkingLevel: MergeReadyWatchUiThinkingLevel;
  auth: MergeReadyWatchUiResolvedRuntimeAuth;
  signature?: string;
};

export type MergeReadyWatchUiRuntimePaths = {
  authStoragePath: string;
  modelRegistryPath: string;
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

export function getMergeReadyWatchUiRuntimePaths(
  agentDir: string,
): MergeReadyWatchUiRuntimePaths {
  return {
    authStoragePath: path.join(agentDir, 'auth.json'),
    modelRegistryPath: path.join(agentDir, 'models.json'),
  };
}

export function getMergeReadyWatchUiSnapshotModelHeaders(
  snapshot: MergeReadyWatchUiRuntimeSnapshot,
): Record<string, string> | undefined {
  const headers = snapshot.auth.headers ?? snapshot.model.headers;
  return headers && Object.keys(headers).length > 0 ? { ...headers } : undefined;
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
  if (snapshot.agentDir.trim().length === 0) {
    throw new MergeReadyWatchUiRuntimePreflightError('runtime snapshot is missing agentDir.');
  }

  if (snapshot.defaultCwd.trim().length === 0) {
    throw new MergeReadyWatchUiRuntimePreflightError('runtime snapshot is missing defaultCwd.');
  }

  if (snapshot.model.provider.trim().length === 0 || snapshot.model.id.trim().length === 0) {
    throw new MergeReadyWatchUiRuntimePreflightError(
      'runtime snapshot is missing model provider/id.',
    );
  }

  if (snapshot.auth.provider.trim().length === 0) {
    throw new MergeReadyWatchUiRuntimePreflightError('runtime snapshot is missing auth provider.');
  }

  if (snapshot.auth.provider !== snapshot.model.provider) {
    throw new MergeReadyWatchUiRuntimePreflightError(
      `runtime snapshot auth provider ${JSON.stringify(snapshot.auth.provider)} does not match model provider ${JSON.stringify(snapshot.model.provider)}.`,
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

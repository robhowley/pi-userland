import { createGitHubProvider } from './github-provider.js';
import type { MergeReadyExec } from './git.js';
import { getErrorMessage } from './internal.js';
import type {
  MergeReadyProviderDetail,
  MergeReadyProviderEvidence,
  MergeReadyProviderReadInput,
  MergeReadyProviderReadResult,
  MergeReadyProviderRemoteMatch,
  MergeReadyProviderRemote,
  MergeReadyProviderUrlMatch,
  MergeReadyProvider,
} from './provider-api.js';
import type { MergeReadyCheckDetails, MergeReadyPullRequest, MergeReadySignals } from './types.js';

export const MERGE_READY_PROVIDER_MAX_TIMEOUT_MS = 20_000;

export type ProviderUrlSelection = {
  provider: MergeReadyProvider;
  target: MergeReadyProviderUrlMatch;
};

export type ProviderRemoteSelection = {
  provider: MergeReadyProvider;
  repository: MergeReadyProviderRemoteMatch;
};

export function createMergeReadyProviders(
  exec: MergeReadyExec,
  customProviders: readonly MergeReadyProvider[] = [],
): readonly MergeReadyProvider[] {
  const builtIn = createGitHubProvider(exec);
  const ids = new Set([builtIn.id]);
  for (const provider of customProviders) {
    validateProvider(provider);
    if (ids.has(provider.id)) {
      throw new Error(
        provider.id === builtIn.id
          ? `Merge-ready provider id ${JSON.stringify(provider.id)} is reserved by a built-in provider.`
          : `Duplicate merge-ready provider id ${JSON.stringify(provider.id)}.`,
      );
    }
    ids.add(provider.id);
  }
  return [builtIn, ...customProviders];
}

export function resolveMergeReadyProviderForUrl(
  url: string,
  providers: readonly MergeReadyProvider[],
): ProviderUrlSelection | null {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    return null;
  }

  const matches: ProviderUrlSelection[] = [];
  for (const provider of providers) {
    let match: unknown;
    try {
      match = provider.matchUrl(parsedUrl);
    } catch (error) {
      throw matcherError(provider.id, 'URL', error);
    }
    if (match === null) continue;
    validateUrlMatch(match, provider.id);
    matches.push({
      provider,
      target: {
        url: match.url,
        owner: match.owner,
        repo: match.repo,
        prNumber: match.prNumber,
      },
    });
  }
  return selectOnlyMatch(matches, url);
}

export function resolveMergeReadyProviderForRemote(
  remote: MergeReadyProviderRemote,
  providers: readonly MergeReadyProvider[],
): ProviderRemoteSelection | null {
  const matches: ProviderRemoteSelection[] = [];
  for (const provider of providers) {
    let match: unknown;
    try {
      match = provider.matchRemote({ name: remote.name, url: remote.url });
    } catch (error) {
      throw matcherError(provider.id, 'remote', error);
    }
    if (match === null) continue;
    validateRemoteMatch(match, provider.id);
    matches.push({
      provider,
      repository: { owner: match.owner, repo: match.repo },
    });
  }
  return selectOnlyMatch(matches, remote.url);
}

type MergeReadyProviderReadInputWithoutTimeout =
  | {
      mode: 'ambient';
      cwd?: string;
      remote: MergeReadyProviderRemote;
      repository: MergeReadyProviderRemoteMatch;
    }
  | {
      mode: 'url';
      cwd?: string;
      target: MergeReadyProviderUrlMatch;
    };

export async function readMergeReadyProvider(
  provider: MergeReadyProvider,
  input: MergeReadyProviderReadInputWithoutTimeout,
  requestedTimeout?: number,
): Promise<MergeReadyProviderReadResult> {
  const timeoutMs = normalizeTimeout(requestedTimeout);
  const publicInput = { ...input, timeoutMs } as MergeReadyProviderReadInput;
  const promise = Promise.resolve().then(() => provider.read(publicInput));
  let result: MergeReadyProviderReadResult;
  try {
    result = await withTimeout(promise, timeoutMs, provider.id);
  } catch (error) {
    if (isProviderTimeout(error)) throw error;
    throw new Error(
      `Merge-ready provider ${JSON.stringify(provider.id)} read failed: ${getErrorMessage(error)}`,
      { cause: error },
    );
  }
  validateReadResult(result, provider.id, publicInput);
  return result;
}

function validateProvider(value: unknown): asserts value is MergeReadyProvider {
  if (!isRecord(value))
    throw new Error('Invalid merge-ready provider contract: expected an object.');
  rejectReadinessFields(value, 'merge-ready provider contract');
  if (!isNonEmptyString(value['id'])) {
    throw new Error('Invalid merge-ready provider contract: id must be a non-empty string.');
  }
  for (const method of ['matchUrl', 'matchRemote', 'read'] as const) {
    if (typeof value[method] !== 'function') {
      throw new Error(
        `Invalid merge-ready provider contract ${JSON.stringify(value['id'])}: ${method} must be a function.`,
      );
    }
  }
}

function validateUrlMatch(value: unknown, id: string): asserts value is MergeReadyProviderUrlMatch {
  if (
    !isRecord(value) ||
    !isAbsoluteHttpUrl(value['url']) ||
    !isNonEmptyString(value['owner']) ||
    !isNonEmptyString(value['repo']) ||
    !isPositiveSafeInteger(value['prNumber'])
  ) {
    throw new Error(`Merge-ready provider ${JSON.stringify(id)} returned a malformed URL match.`);
  }
}

function validateRemoteMatch(
  value: unknown,
  id: string,
): asserts value is MergeReadyProviderRemoteMatch {
  if (!isRecord(value) || !isNonEmptyString(value['owner']) || !isNonEmptyString(value['repo'])) {
    throw new Error(
      `Merge-ready provider ${JSON.stringify(id)} returned a malformed remote match.`,
    );
  }
}

function validateReadResult(
  value: unknown,
  id: string,
  input: MergeReadyProviderReadInput,
): asserts value is MergeReadyProviderReadResult {
  const malformed = (): never => {
    throw new Error(`Merge-ready provider ${JSON.stringify(id)} returned a malformed read result.`);
  };
  if (!isRecord(value)) return malformed();
  rejectReadinessFields(value, `merge-ready provider ${JSON.stringify(id)} read result`);
  if (value['kind'] === 'absent') return;
  if (value['kind'] === 'unavailable') {
    if (
      (value['presence'] !== 'known' && value['presence'] !== 'unknown') ||
      !isNonEmptyString(value['message'])
    )
      return malformed();
    return;
  }
  if (value['kind'] !== 'found' || !isPullRequest(value['pullRequest'])) return malformed();
  const pullRequest = value['pullRequest'];
  if (pullRequest.lifecycle === 'open') {
    if (!isSignals(value['signals'])) return malformed();
    if (value['evidence'] !== undefined && !isEvidence(value['evidence'])) return malformed();
    if (
      value['issues'] !== undefined &&
      (!Array.isArray(value['issues']) || !value['issues'].every(isNonEmptyString))
    )
      return malformed();
  } else if (
    ('signals' in value && !isSignals(value['signals'])) ||
    'evidence' in value ||
    'issues' in value
  ) {
    return malformed();
  }
  if (
    input.mode === 'url' &&
    (pullRequest.number !== input.target.prNumber ||
      new URL(pullRequest.url).href !== new URL(input.target.url).href)
  )
    return malformed();
}

function isPullRequest(value: unknown): value is MergeReadyPullRequest {
  return (
    isRecord(value) &&
    (value['lifecycle'] === 'open' ||
      value['lifecycle'] === 'merged' ||
      value['lifecycle'] === 'closed') &&
    isPositiveSafeInteger(value['number']) &&
    typeof value['title'] === 'string' &&
    isAbsoluteHttpUrl(value['url']) &&
    isNonEmptyString(value['headRefName']) &&
    isNonEmptyString(value['baseRefName']) &&
    (value['headRepository'] === undefined || isRepository(value['headRepository']))
  );
}

function isSignals(value: unknown): value is MergeReadySignals {
  if (!isRecord(value)) return false;
  if (
    typeof value['draft'] !== 'boolean' ||
    !includes(
      ['mergeable', 'conflicting', 'behind', 'blocked', 'unknown'],
      value['mergeability'],
    ) ||
    !includes(['passing', 'failing', 'running', 'unknown'], value['checks']) ||
    !includes(['approved', 'changes_requested', 'pending', 'unknown'], value['review']) ||
    typeof value['unresolvedConversations'] !== 'boolean' ||
    !includes(['required', 'optional', 'unknown'], value['unresolvedConversationRequirement']) ||
    (value['unresolvedConversationCount'] !== undefined &&
      (!Number.isSafeInteger(value['unresolvedConversationCount']) ||
        (value['unresolvedConversationCount'] as number) < 0))
  )
    return false;
  return value['checkDetails'] === undefined || isCheckDetails(value['checkDetails']);
}

function isCheckDetails(value: unknown): value is MergeReadyCheckDetails {
  return (
    isRecord(value) &&
    isDetailBucket(value['failing'], 'failing') &&
    isDetailBucket(value['running'], 'running') &&
    isDetailBucket(value['unknown'], 'unknown')
  );
}

function isDetailBucket(value: unknown, status: string): boolean {
  return Array.isArray(value) && value.every((item) => isDetail(item) && item.status === status);
}

function isEvidence(value: unknown): value is MergeReadyProviderEvidence {
  return (
    isRecord(value) &&
    ['reviewPending', 'changesRequested', 'unresolvedConversations'].every(
      (key) =>
        value[key] === undefined || (Array.isArray(value[key]) && value[key].every(isDetail)),
    )
  );
}

function isDetail(value: unknown): value is MergeReadyProviderDetail & { status?: string } {
  return (
    isRecord(value) &&
    isNonEmptyString(value['label']) &&
    (value['url'] === undefined || isAbsoluteHttpUrl(value['url']))
  );
}

function isRepository(value: unknown): boolean {
  return isRecord(value) && isNonEmptyString(value['owner']) && isNonEmptyString(value['repo']);
}

function rejectReadinessFields(value: Record<string, unknown>, subject: string): void {
  for (const key of ['state', 'summary', 'openItems']) {
    if (key in value)
      throw new Error(`${subject} must not supply forbidden field ${JSON.stringify(key)}.`);
  }
}

function normalizeTimeout(value: number | undefined): number {
  if (!Number.isFinite(value)) return MERGE_READY_PROVIDER_MAX_TIMEOUT_MS;
  return Math.max(1, Math.min(Math.floor(value!), MERGE_READY_PROVIDER_MAX_TIMEOUT_MS));
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, id: string): Promise<T> {
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
      timer = undefined;
      const error = new Error(
        `Merge-ready provider ${JSON.stringify(id)} read timed out after ${String(timeoutMs)}ms.`,
      );
      Object.assign(error, { providerTimeout: true });
      reject(error);
    }, timeoutMs);
    timer.unref?.();
    void promise.then(
      (result) => {
        if (timer !== undefined) clearTimeout(timer);
        timer = undefined;
        resolve(result);
      },
      (error: unknown) => {
        if (timer !== undefined) clearTimeout(timer);
        timer = undefined;
        reject(error);
      },
    );
  });
}

function isProviderTimeout(value: unknown): boolean {
  return isRecord(value) && value['providerTimeout'] === true;
}

function selectOnlyMatch<T extends { provider: MergeReadyProvider }>(
  matches: T[],
  target: string,
): T | null {
  if (matches.length > 1) {
    throw new Error(
      `Multiple merge-ready providers matched ${JSON.stringify(target)}: ${matches.map(({ provider }) => provider.id).join(', ')}.`,
    );
  }
  return matches[0] ?? null;
}

function matcherError(id: string, kind: string, error: unknown): Error {
  return new Error(
    `Merge-ready provider ${JSON.stringify(id)} ${kind} matcher failed: ${getErrorMessage(error)}`,
    { cause: error },
  );
}

function includes(values: readonly string[], value: unknown): value is string {
  return typeof value === 'string' && values.includes(value);
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}
function isAbsoluteHttpUrl(value: unknown): value is string {
  if (!isNonEmptyString(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

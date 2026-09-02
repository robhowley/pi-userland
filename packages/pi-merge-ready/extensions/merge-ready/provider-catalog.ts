import type {
  MergeReadyProviderDetailV1,
  MergeReadyProviderFactV1,
  MergeReadyProviderFactsV1,
  MergeReadyProviderPullRequestV1,
  MergeReadyProviderReadInputV1,
  MergeReadyProviderReadResultV1,
  MergeReadyProviderRemoteMatchV1,
  MergeReadyProviderRequiredCheckV1,
  MergeReadyProviderSourceReviewGateV1,
  MergeReadyProviderUrlMatchV1,
  MergeReadyProviderV1,
} from './provider-api.js';
import { BUILT_IN_MERGE_READY_PROVIDERS } from './provider-registry.js';
import type {
  MergeReadyProvider,
  ProviderReadInput,
  ProviderReadResult,
  ProviderSnapshot,
} from './provider.js';

export const CUSTOM_MERGE_READY_PROVIDER_MAX_TIMEOUT_MS = 20_000;

const PROVIDER_PULL_REQUEST_LIFECYCLES = ['open', 'merged', 'closed'] as const;
const PROVIDER_SOURCE_MERGE_GATE_VALUES = ['clear', 'blocked'] as const;
const PROVIDER_REQUIRED_CHECK_STATUS_VALUES = ['passed', 'failed', 'running', 'unknown'] as const;
const PROVIDER_SOURCE_REVIEW_GATE_VALUES = ['satisfied', 'changes_requested', 'pending'] as const;
const PROVIDER_PRESENCE_VALUES = ['known', 'unknown'] as const;

export type MergeReadyProviderCatalog = readonly MergeReadyProvider[];

export function createMergeReadyProviderCatalog(
  customProviders: readonly MergeReadyProviderV1[] = [],
): MergeReadyProviderCatalog {
  const ids = new Set(BUILT_IN_MERGE_READY_PROVIDERS.map((provider) => provider.id));
  const adapters: MergeReadyProvider[] = [];

  for (const candidate of customProviders) {
    validateProviderContract(candidate);
    if (ids.has(candidate.id)) {
      const builtInCollision = BUILT_IN_MERGE_READY_PROVIDERS.some(
        (provider) => provider.id === candidate.id,
      );
      throw new Error(
        builtInCollision
          ? `Merge-ready provider id ${JSON.stringify(candidate.id)} is reserved by a built-in provider.`
          : `Duplicate merge-ready provider id ${JSON.stringify(candidate.id)}.`,
      );
    }

    ids.add(candidate.id);
    adapters.push(adaptProvider(candidate));
  }

  return Object.freeze([...BUILT_IN_MERGE_READY_PROVIDERS, ...adapters]);
}

function validateProviderContract(provider: unknown): asserts provider is MergeReadyProviderV1 {
  if (!isRecord(provider)) {
    throw new Error('Invalid merge-ready provider contract: expected an object.');
  }
  rejectForbiddenReadinessFields(provider, 'merge-ready provider contract');

  if (provider['apiVersion'] !== 1) {
    throw new Error('Invalid merge-ready provider contract: apiVersion must be 1.');
  }
  if (!isNonEmptyString(provider['id'])) {
    throw new Error('Invalid merge-ready provider contract: id must be a non-empty string.');
  }
  for (const method of ['matchUrl', 'matchRemote', 'read'] as const) {
    if (typeof provider[method] !== 'function') {
      throw new Error(
        `Invalid merge-ready provider contract ${JSON.stringify(provider['id'])}: ${method} must be a function.`,
      );
    }
  }
}

function adaptProvider(provider: MergeReadyProviderV1): MergeReadyProvider {
  const id = provider.id;
  const matchUrl = provider.matchUrl.bind(provider);
  const matchRemote = provider.matchRemote.bind(provider);
  const read = provider.read.bind(provider);

  return Object.freeze({
    id,
    parseUrl(url: URL) {
      const match = matchUrl(url);
      if (match === null) return null;
      validateUrlMatch(match, id);
      return { mode: 'url' as const, ...match };
    },
    parseRemote(remote) {
      const match = matchRemote({ name: remote.name, url: remote.url });
      if (match === null) return null;
      validateRemoteMatch(match, id);
      return match;
    },
    async read(input: ProviderReadInput) {
      const publicInput = toPublicReadInput(input);
      let result: MergeReadyProviderReadResultV1;
      try {
        result = await withTimeout(Promise.resolve(read(publicInput)), publicInput.timeoutMs, id);
      } catch (error) {
        if (isProviderTimeout(error)) throw error;
        throw new Error(
          `Merge-ready provider ${JSON.stringify(id)} read failed: ${getErrorMessage(error)}`,
          { cause: error },
        );
      }

      validateReadResult(result, id, publicInput);
      return adaptReadResult(result);
    },
  } satisfies MergeReadyProvider);
}

function toPublicReadInput(input: ProviderReadInput): MergeReadyProviderReadInputV1 {
  const requestedTimeout = input.timeout ?? CUSTOM_MERGE_READY_PROVIDER_MAX_TIMEOUT_MS;
  const timeoutMs = Number.isFinite(requestedTimeout)
    ? Math.max(
        1,
        Math.min(Math.floor(requestedTimeout), CUSTOM_MERGE_READY_PROVIDER_MAX_TIMEOUT_MS),
      )
    : CUSTOM_MERGE_READY_PROVIDER_MAX_TIMEOUT_MS;
  const base = { ...(input.cwd === undefined ? {} : { cwd: input.cwd }), timeoutMs };

  if (input.mode === 'url') return { ...base, mode: 'url', target: input.target };
  if (input.remote === undefined) {
    throw new Error('Custom merge-ready providers require remote identity.');
  }
  return {
    ...base,
    mode: 'ambient',
    remote: { name: input.remote.name, url: input.remote.url },
    repository: input.repository,
  };
}

function adaptReadResult(result: MergeReadyProviderReadResultV1): ProviderReadResult {
  if (result.kind === 'absent') return result;
  if (result.kind === 'unavailable') {
    return {
      kind: 'unavailable',
      presence: result.presence,
      issues: [{ message: result.message }],
    };
  }

  const snapshot: ProviderSnapshot =
    result.pullRequest.lifecycle === 'open'
      ? { pullRequest: result.pullRequest, facts: result.facts! }
      : { pullRequest: result.pullRequest };
  return { kind: 'found', snapshot };
}

function validateUrlMatch(
  value: unknown,
  id: string,
): asserts value is MergeReadyProviderUrlMatchV1 {
  if (
    !hasOnlyKeys(value, ['url', 'owner', 'repo', 'prNumber']) ||
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
): asserts value is MergeReadyProviderRemoteMatchV1 {
  if (
    !hasOnlyKeys(value, ['owner', 'repo']) ||
    !isNonEmptyString(value['owner']) ||
    !isNonEmptyString(value['repo'])
  ) {
    throw new Error(
      `Merge-ready provider ${JSON.stringify(id)} returned a malformed remote match.`,
    );
  }
}

function validateReadResult(
  value: unknown,
  id: string,
  input: MergeReadyProviderReadInputV1,
): asserts value is MergeReadyProviderReadResultV1 {
  const malformed = (): never => {
    throw new Error(`Merge-ready provider ${JSON.stringify(id)} returned a malformed read result.`);
  };
  if (!isRecord(value)) return malformed();
  rejectForbiddenReadinessFields(value, `merge-ready provider ${JSON.stringify(id)} read result`);

  if (value['kind'] === 'absent') {
    if (!hasOnlyKeys(value, ['kind'])) return malformed();
    return;
  }
  if (value['kind'] === 'unavailable') {
    if (
      !hasOnlyKeys(value, ['kind', 'presence', 'message']) ||
      !isAllowedString(value['presence'], PROVIDER_PRESENCE_VALUES) ||
      !isNonEmptyString(value['message'])
    ) {
      return malformed();
    }
    return;
  }

  const pullRequest = value['pullRequest'];
  if (
    value['kind'] !== 'found' ||
    !hasOnlyKeys(value, ['kind', 'pullRequest', 'facts']) ||
    !isPullRequest(pullRequest)
  ) {
    return malformed();
  }
  if (pullRequest.lifecycle === 'open') {
    validateFacts(value['facts'], malformed);
  } else if ('facts' in value) {
    return malformed();
  }
  if (
    input.mode === 'url' &&
    (pullRequest.number !== input.target.prNumber ||
      normalizeUrl(pullRequest.url) !== normalizeUrl(input.target.url))
  ) {
    return malformed();
  }
}

function validateFacts(
  value: unknown,
  malformed: () => never,
): asserts value is MergeReadyProviderFactsV1 {
  if (
    !hasOnlyKeys(value, [
      'draft',
      'hasConflicts',
      'behindBase',
      'sourceMergeGate',
      'requiredChecks',
      'sourceReviewGate',
      'unresolvedConversations',
      'conversationResolutionRequired',
    ]) ||
    !isFact(value['draft'], isBoolean) ||
    !isFact(value['hasConflicts'], isBoolean) ||
    !isFact(value['behindBase'], isBoolean) ||
    !isFact(value['sourceMergeGate'], (item) =>
      isAllowedString(item, PROVIDER_SOURCE_MERGE_GATE_VALUES),
    ) ||
    !isFact(value['requiredChecks'], isRequiredChecks) ||
    !isFact(value['sourceReviewGate'], isSourceReviewGate) ||
    !isFact(value['unresolvedConversations'], isDetails) ||
    !isFact(value['conversationResolutionRequired'], isBoolean)
  ) {
    return malformed();
  }
}

function isFact<T>(
  value: unknown,
  isValue: (value: unknown) => boolean,
): value is MergeReadyProviderFactV1<T> {
  return (
    (hasOnlyKeys(value, ['kind', 'value']) &&
      value['kind'] === 'known' &&
      isValue(value['value'])) ||
    (hasOnlyKeys(value, ['kind', 'value', 'message']) &&
      value['kind'] === 'partial' &&
      isValue(value['value']) &&
      isNonEmptyString(value['message'])) ||
    (hasOnlyKeys(value, ['kind', 'message']) &&
      value['kind'] === 'unknown' &&
      isNonEmptyString(value['message']))
  );
}

function isRequiredChecks(value: unknown): value is readonly MergeReadyProviderRequiredCheckV1[] {
  return (
    Array.isArray(value) &&
    value.every(
      (check) =>
        isDetail(check, ['label', 'url', 'status']) &&
        isAllowedString(check['status'], PROVIDER_REQUIRED_CHECK_STATUS_VALUES),
    )
  );
}

function isSourceReviewGate(value: unknown): value is MergeReadyProviderSourceReviewGateV1 {
  return (
    hasOnlyKeys(value, ['state', 'details']) &&
    isAllowedString(value['state'], PROVIDER_SOURCE_REVIEW_GATE_VALUES) &&
    (value['details'] === undefined || isDetails(value['details']))
  );
}

function isDetails(value: unknown): value is readonly MergeReadyProviderDetailV1[] {
  return Array.isArray(value) && value.every((detail) => isDetail(detail, ['label', 'url']));
}

function isDetail(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return (
    hasOnlyKeys(value, keys) &&
    isNonEmptyString(value['label']) &&
    (value['url'] === undefined || isAbsoluteHttpUrl(value['url']))
  );
}

function isPullRequest(value: unknown): value is MergeReadyProviderPullRequestV1 {
  return (
    hasOnlyKeys(value, [
      'lifecycle',
      'number',
      'title',
      'url',
      'headRefName',
      'baseRefName',
      'headRepository',
    ]) &&
    isAllowedString(value['lifecycle'], PROVIDER_PULL_REQUEST_LIFECYCLES) &&
    isPositiveSafeInteger(value['number']) &&
    typeof value['title'] === 'string' &&
    isAbsoluteHttpUrl(value['url']) &&
    isNonEmptyString(value['headRefName']) &&
    isNonEmptyString(value['baseRefName']) &&
    (value['headRepository'] === undefined || isRemoteMatch(value['headRepository']))
  );
}

function isRemoteMatch(value: unknown): value is MergeReadyProviderRemoteMatchV1 {
  return (
    hasOnlyKeys(value, ['owner', 'repo']) &&
    isNonEmptyString(value['owner']) &&
    isNonEmptyString(value['repo'])
  );
}

function rejectForbiddenReadinessFields(value: Record<string, unknown>, subject: string): void {
  for (const key of ['state', 'summary', 'openItems', 'signals']) {
    if (key in value) {
      throw new Error(`${subject} must not supply forbidden field ${JSON.stringify(key)}.`);
    }
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, id: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
      timer = undefined;
      const error = new Error(
        `Merge-ready provider ${JSON.stringify(id)} read timed out after ${String(timeoutMs)}ms.`,
      );
      Object.assign(error, { providerTimeout: true });
      reject(error);
    }, timeoutMs);
    timer.unref?.();

    const cleanup = () => {
      if (timer === undefined) return;
      clearTimeout(timer);
      timer = undefined;
    };
    void promise.then(
      (result) => {
        cleanup();
        resolve(result);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}

function isProviderTimeout(error: unknown): boolean {
  return isRecord(error) && error['providerTimeout'] === true;
}

function hasOnlyKeys(
  value: unknown,
  allowedKeys: readonly string[],
): value is Record<string, unknown> {
  return isRecord(value) && Object.keys(value).every((key) => allowedKeys.includes(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isAllowedString<T extends string>(
  value: unknown,
  allowedValues: readonly T[],
): value is T {
  return typeof value === 'string' && allowedValues.includes(value as T);
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === 'boolean';
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
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

function normalizeUrl(value: string): string {
  return new URL(value).href;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

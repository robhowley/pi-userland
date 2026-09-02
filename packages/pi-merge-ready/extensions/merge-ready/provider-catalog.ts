import type {
  MergeReadyProviderChecksV1,
  MergeReadyProviderEvidenceDetailV1,
  MergeReadyProviderEvidenceV1,
  MergeReadyProviderFactV1,
  MergeReadyProviderFactsV1,
  MergeReadyProviderPullRequestV1,
  MergeReadyProviderReadInputV1,
  MergeReadyProviderReadResultV1,
  MergeReadyProviderRemoteMatchV1,
  MergeReadyProviderUrlMatchV1,
  MergeReadyProviderV1,
} from './provider-api.js';
import { BUILT_IN_MERGE_READY_PROVIDERS } from './provider-registry.js';
import type {
  MergeReadyProvider,
  ProviderIssue,
  ProviderReadInput,
  ProviderReadResult,
  ProviderSnapshot,
  ProviderSupportingEvidence,
} from './provider.js';
import type { MergeReadySignals } from './types.js';

export const CUSTOM_MERGE_READY_PROVIDER_MAX_TIMEOUT_MS = 20_000;

const PROVIDER_PULL_REQUEST_LIFECYCLES = ['open', 'merged', 'closed'] as const;
const PROVIDER_MERGEABILITY_VALUES = ['mergeable', 'conflicting', 'behind', 'blocked'] as const;
const PROVIDER_CHECK_STATE_VALUES = ['passing', 'failing', 'running'] as const;
const PROVIDER_REVIEW_VALUES = ['approved', 'changes_requested', 'pending'] as const;
const PROVIDER_EVIDENCE_STATUS_VALUES = ['failing', 'running', 'unknown'] as const;
const PROVIDER_CONVERSATION_REQUIREMENT_VALUES = ['required', 'optional'] as const;
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
  rejectForbiddenTopLevelFields(provider, 'merge-ready provider contract');

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

  const adapter: MergeReadyProvider = {
    id,
    parseUrl(url) {
      const match = matchUrl(url);
      if (match === null) {
        return null;
      }
      validateUrlMatch(match, id);
      return { mode: 'url', ...match };
    },
    parseRemote(remote) {
      const match = matchRemote({ name: remote.name, url: remote.url });
      if (match === null) {
        return null;
      }
      validateRemoteMatch(match, id);
      return match;
    },
    async read(input) {
      const publicInput = toPublicReadInput(input);
      let result: MergeReadyProviderReadResultV1;
      try {
        result = await withTimeout(Promise.resolve(read(publicInput)), publicInput.timeoutMs, id);
      } catch (error) {
        if (isProviderTimeout(error)) {
          throw error;
        }
        throw new Error(
          `Merge-ready provider ${JSON.stringify(id)} read failed: ${getErrorMessage(error)}`,
          { cause: error },
        );
      }

      validateReadResult(result, id, publicInput);
      return adaptReadResult(result);
    },
  };
  return Object.freeze(adapter);
}

function toPublicReadInput(input: ProviderReadInput): MergeReadyProviderReadInputV1 {
  const requestedTimeout = input.timeout ?? CUSTOM_MERGE_READY_PROVIDER_MAX_TIMEOUT_MS;
  const timeoutMs = Number.isFinite(requestedTimeout)
    ? Math.max(
        1,
        Math.min(Math.floor(requestedTimeout), CUSTOM_MERGE_READY_PROVIDER_MAX_TIMEOUT_MS),
      )
    : CUSTOM_MERGE_READY_PROVIDER_MAX_TIMEOUT_MS;
  const base = {
    ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
    timeoutMs,
  };

  if (input.mode === 'url') {
    return { ...base, mode: 'url', target: input.target };
  }
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
  if (result.kind === 'absent') {
    return result;
  }
  if (result.kind === 'unavailable') {
    return {
      kind: 'unavailable',
      presence: result.presence,
      issues: [{ message: result.message }],
    };
  }

  const { signals, issues } = adaptFacts(result.facts);
  const snapshot: ProviderSnapshot = {
    pullRequest: result.pullRequest,
    signals,
    supportingEvidence: adaptEvidence(result.evidence),
    integrityIssues: issues,
  };
  return { kind: 'found', snapshot };
}

function adaptFacts(facts: MergeReadyProviderFactsV1): {
  signals: MergeReadySignals;
  issues: ProviderIssue[];
} {
  const issues: ProviderIssue[] = [];
  const readFact = <T>(fact: MergeReadyProviderFactV1<T>, fallback: T): T => {
    if (fact.kind === 'known') {
      return fact.value;
    }
    issues.push({ message: fact.message });
    return fallback;
  };

  const checks =
    facts.checks.kind === 'known'
      ? facts.checks.value
      : (issues.push({ message: facts.checks.message }), { state: 'unknown' as const });
  const conversations =
    facts.conversations.kind === 'known'
      ? facts.conversations.value
      : (issues.push({ message: facts.conversations.message }),
        { unresolvedCount: 0, requirement: 'unknown' as const });

  return {
    signals: {
      draft: readFact(facts.draft, false),
      mergeability: readFact(facts.mergeability, 'unknown'),
      checks: checks.state,
      ...('details' in checks && checks.details !== undefined
        ? { checkDetails: checks.details }
        : {}),
      review: readFact(facts.review, 'unknown'),
      unresolvedConversations: conversations.unresolvedCount > 0,
      ...(conversations.unresolvedCount > 0
        ? { unresolvedConversationCount: conversations.unresolvedCount }
        : {}),
      unresolvedConversationRequirement: conversations.requirement,
    },
    issues,
  };
}

function adaptEvidence(
  evidence: MergeReadyProviderEvidenceV1 | undefined,
): ProviderSupportingEvidence {
  return evidence ?? {};
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
  if (!isRecord(value)) {
    return malformed();
  }
  rejectForbiddenTopLevelFields(value, `merge-ready provider ${JSON.stringify(id)} read result`);

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
    !hasOnlyKeys(value, ['kind', 'pullRequest', 'facts', 'evidence']) ||
    !isPullRequest(pullRequest)
  ) {
    return malformed();
  }
  validateFacts(value['facts'], malformed);
  if (value['evidence'] !== undefined && !isEvidence(value['evidence'])) {
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
    !hasOnlyKeys(value, ['draft', 'mergeability', 'checks', 'review', 'conversations']) ||
    !isFact(value['draft'], (item) => typeof item === 'boolean') ||
    !isFact(value['mergeability'], (item) => isAllowedString(item, PROVIDER_MERGEABILITY_VALUES)) ||
    !isFact(value['checks'], isChecks) ||
    !isFact(value['review'], (item) => isAllowedString(item, PROVIDER_REVIEW_VALUES)) ||
    !isFact(value['conversations'], isConversations)
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
    (hasOnlyKeys(value, ['kind', 'message']) &&
      value['kind'] === 'unknown' &&
      isNonEmptyString(value['message']))
  );
}

function isChecks(value: unknown): value is MergeReadyProviderChecksV1 {
  if (
    !hasOnlyKeys(value, ['state', 'details']) ||
    !isAllowedString(value['state'], PROVIDER_CHECK_STATE_VALUES)
  ) {
    return false;
  }
  const details = value['details'];
  if (details === undefined) return true;
  if (!hasOnlyKeys(details, ['failing', 'running', 'unknown'])) return false;
  return (['failing', 'running', 'unknown'] as const).every(
    (bucket) =>
      Array.isArray(details[bucket]) &&
      details[bucket].every((detail: unknown) => isCheckDetail(detail, bucket)),
  );
}

function isConversations(
  value: unknown,
): value is { unresolvedCount: number; requirement: 'required' | 'optional' } {
  return (
    hasOnlyKeys(value, ['unresolvedCount', 'requirement']) &&
    Number.isSafeInteger(value['unresolvedCount']) &&
    (value['unresolvedCount'] as number) >= 0 &&
    isAllowedString(value['requirement'], PROVIDER_CONVERSATION_REQUIREMENT_VALUES)
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

function isEvidence(value: unknown): value is MergeReadyProviderEvidenceV1 {
  return (
    hasOnlyKeys(value, ['reviewPending', 'changesRequested', 'unresolvedConversations']) &&
    ['reviewPending', 'changesRequested', 'unresolvedConversations'].every(
      (key) =>
        value[key] === undefined ||
        (Array.isArray(value[key]) && value[key].every((detail) => isEvidenceDetail(detail))),
    )
  );
}

function isCheckDetail(value: unknown, expectedStatus: string): boolean {
  return isEvidenceDetail(value) && value.status === expectedStatus;
}

function isEvidenceDetail(value: unknown): value is MergeReadyProviderEvidenceDetailV1 {
  return (
    hasOnlyKeys(value, ['label', 'status', 'url']) &&
    isNonEmptyString(value['label']) &&
    (value['status'] === undefined ||
      isAllowedString(value['status'], PROVIDER_EVIDENCE_STATUS_VALUES)) &&
    (value['url'] === undefined || isAbsoluteHttpUrl(value['url']))
  );
}

function rejectForbiddenTopLevelFields(value: Record<string, unknown>, subject: string): void {
  for (const key of ['state', 'summary', 'openItems']) {
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
      if (timer === undefined) {
        return;
      }

      clearTimeout(timer);
      timer = undefined;
    };

    void promise.then(
      (value) => {
        cleanup();
        resolve(value);
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

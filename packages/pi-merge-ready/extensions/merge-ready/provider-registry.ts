import { githubProvider } from './github-provider.js';
import type {
  MergeReadyProvider,
  ProviderRemote as ProviderRemoteInput,
  ProviderRepository,
  ProviderUrlTarget,
} from './provider.js';

export const BUILT_IN_MERGE_READY_PROVIDERS = [
  githubProvider,
] as const satisfies readonly MergeReadyProvider[];

export type ProviderUrlSelection = {
  provider: MergeReadyProvider;
  target: ProviderUrlTarget;
};

export type ProviderRemote = ProviderRemoteInput;

export type ProviderRemoteSelection = {
  provider: MergeReadyProvider;
  repository: ProviderRepository;
};

export function resolveMergeReadyProviderForUrl(
  url: string,
  providers: readonly MergeReadyProvider[] = BUILT_IN_MERGE_READY_PROVIDERS,
): ProviderUrlSelection | null {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    return null;
  }

  const matches = providers.flatMap((provider) => {
    let target: ProviderUrlTarget | null;
    try {
      target = provider.parseUrl(parsedUrl);
    } catch (error) {
      throw matcherError(provider.id, 'URL', error);
    }
    return target ? [{ provider, target }] : [];
  });

  return selectOnlyMatch(matches, url);
}

export function resolveMergeReadyProviderForRemote(
  remote: ProviderRemote,
  providers: readonly MergeReadyProvider[] = BUILT_IN_MERGE_READY_PROVIDERS,
): ProviderRemoteSelection | null {
  const matches = providers.flatMap((provider) => {
    let repository: ProviderRepository | null;
    try {
      repository = provider.parseRemote(remote);
    } catch (error) {
      throw matcherError(provider.id, 'remote', error);
    }
    return repository ? [{ provider, repository }] : [];
  });

  return selectOnlyMatch(matches, remote.url);
}

function selectOnlyMatch<T extends { provider: MergeReadyProvider }>(
  matches: T[],
  concreteTarget: string,
): T | null {
  if (matches.length > 1) {
    throw new Error(
      `Multiple merge-ready providers matched ${JSON.stringify(concreteTarget)}: ${matches
        .map((match) => match.provider.id)
        .join(', ')}.`,
    );
  }
  return matches[0] ?? null;
}

function matcherError(id: string, kind: string, error: unknown): Error {
  return new Error(
    `Merge-ready provider ${JSON.stringify(id)} ${kind} matcher failed: ${error instanceof Error ? error.message : String(error)}`,
    { cause: error },
  );
}

import { githubProvider } from './github-provider.js';
import type { MergeReadyProvider, ProviderRepository, ProviderUrlTarget } from './provider.js';

export const BUILT_IN_MERGE_READY_PROVIDERS = [
  githubProvider,
] as const satisfies readonly MergeReadyProvider[];

export type ProviderUrlSelection = {
  provider: MergeReadyProvider;
  target: ProviderUrlTarget;
};

export type ProviderRemote = {
  name: string;
  url: string;
};

export type ProviderRemoteSelection = {
  provider: MergeReadyProvider;
  repository: ProviderRepository;
};

export function resolveMergeReadyProviderForUrl(url: string): ProviderUrlSelection | null {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    return null;
  }

  for (const provider of BUILT_IN_MERGE_READY_PROVIDERS) {
    const target = provider.parseUrl(parsedUrl);
    if (target) {
      return { provider, target };
    }
  }

  return null;
}

export function resolveMergeReadyProviderForRemote(
  remote: ProviderRemote,
): ProviderRemoteSelection | null {
  for (const provider of BUILT_IN_MERGE_READY_PROVIDERS) {
    const repository = provider.parseRemote(remote.url);
    if (repository) {
      return { provider, repository };
    }
  }

  return null;
}

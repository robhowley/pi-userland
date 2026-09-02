import { describe, expect, it } from 'vitest';
import { githubProvider } from '../../extensions/merge-ready/github-provider.js';
import {
  BUILT_IN_MERGE_READY_PROVIDERS,
  resolveMergeReadyProviderForRemote,
  resolveMergeReadyProviderForUrl,
} from '../../extensions/merge-ready/provider-registry.js';

const TARGET_URL = 'https://github.com/shopify/pi/pull/64';

describe('merge-ready provider registry', () => {
  it('contains only the private built-in GitHub provider', async () => {
    expect(BUILT_IN_MERGE_READY_PROVIDERS).toEqual([githubProvider]);

    const publicApi = await import('../../extensions/merge-ready/index.js');
    expect(publicApi).not.toHaveProperty('githubProvider');
    expect(publicApi).not.toHaveProperty('BUILT_IN_MERGE_READY_PROVIDERS');
  });

  it('selects the provider only for strict exact GitHub pull request URLs', () => {
    expect(resolveMergeReadyProviderForUrl(TARGET_URL)).toEqual({
      provider: githubProvider,
      target: {
        mode: 'url',
        url: TARGET_URL,
        owner: 'shopify',
        repo: 'pi',
        prNumber: 64,
      },
    });
    expect(resolveMergeReadyProviderForUrl(`${TARGET_URL}?tab=checks`)).toBeNull();
    expect(
      resolveMergeReadyProviderForUrl('https://gitlab.com/shopify/pi/-/merge_requests/64'),
    ).toBeNull();
  });

  it('selects from the selected remote name and raw URL without using the legacy fact', () => {
    expect(
      resolveMergeReadyProviderForRemote({
        name: 'upstream',
        url: 'git@github.com:shopify/pi.git',
      }),
    ).toEqual({
      provider: githubProvider,
      repository: { owner: 'shopify', repo: 'pi' },
    });
    expect(
      resolveMergeReadyProviderForRemote({
        name: 'origin',
        url: 'git@gitlab.com:shopify/pi.git',
      }),
    ).toBeNull();
  });
});

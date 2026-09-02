import { registerMergeReadyCommand, type MergeReadyCommandAPI } from './commands.js';
import { createMergeReadyProviderCatalog } from './provider-catalog.js';
import {
  MERGE_READY_PROVIDER_COLLECTION_EVENT_V1,
  type MergeReadyProviderV1,
} from './provider-api.js';
import {
  createCatalogBoundMergeReadyStatusReader,
  getMergeReadyStatus,
  type MergeReadyStatusReader,
} from './merge-ready.js';
import { resolveMergeReadyProviderForUrl } from './provider-registry.js';
import { registerMergeReadyStatusBar, type MergeReadyStatusBarAPI } from './status-bar.js';
import { assertValidGitHubPullRequestUrl } from './target.js';
import { registerMergeReadyStatusTool, type MergeReadyStatusToolAPI } from './tool.js';

export * from './types.js';
export * from './target.js';
export * from './status.js';
export * from './git.js';
export * from './github.js';
export * from './conversations.js';
export {
  getMergeReadyStatus,
  type GetMergeReadyStatusClock,
  type GetMergeReadyStatusOptions,
  type MergeReadyStatusReader,
} from './merge-ready.js';
export type {
  MergeReadyProviderDetailV1,
  MergeReadyProviderFactsV1,
  MergeReadyProviderFactV1,
  MergeReadyProviderRequiredCheckV1,
  MergeReadyProviderSourceReviewGateV1,
  MergeReadyProviderPullRequestV1,
  MergeReadyProviderReadInputV1,
  MergeReadyProviderReadResultV1,
  MergeReadyProviderRemoteMatchV1,
  MergeReadyProviderRemoteV1,
  MergeReadyProviderUrlMatchV1,
  MergeReadyProviderV1,
} from './provider-api.js';
export { defineMergeReadyProvider, registerMergeReadyProvider } from './provider-api.js';
export * from './commands.js';
export * from './config.js';
export * from './status-bar.js';
export * from './tool.js';
export * from './watch.js';
export * from './watch-status.js';
export * from './watch-ui/launcher.js';
export * from './watch-ui/runtime-snapshot.js';
export * from './watch-ui/supervisor-client.js';
export * from './watch-ui/supervisor-state.js';
export * from './watch-ui/transcript.js';

export type MergeReadyExtensionAPI = MergeReadyCommandAPI &
  MergeReadyStatusBarAPI &
  MergeReadyStatusToolAPI & {
    events?: {
      emit(channel: string, data: unknown): void;
    };
  };

export default function (pi: MergeReadyExtensionAPI): void {
  let catalog = createMergeReadyProviderCatalog();
  let sessionGetStatus: MergeReadyStatusReader = getMergeReadyStatus;
  const getSessionStatus: MergeReadyStatusReader = (options) => sessionGetStatus(options);
  const getCurrentStatusReader = () => sessionGetStatus;
  const normalizeUrl = (url: string): string => {
    const selection = resolveMergeReadyProviderForUrl(url, catalog);
    return selection?.target.url ?? assertValidGitHubPullRequestUrl(url).url;
  };

  registerMergeReadyStatusBar(pi, {
    getStatus: getSessionStatus,
    beforeInitialRefresh: () => {
      const providers: MergeReadyProviderV1[] = [];
      pi.events?.emit(MERGE_READY_PROVIDER_COLLECTION_EVENT_V1, { providers });
      catalog = createMergeReadyProviderCatalog(providers);
      sessionGetStatus = createCatalogBoundMergeReadyStatusReader(catalog);
    },
  });
  registerMergeReadyCommand(pi, { getStatus: getCurrentStatusReader, normalizeUrl });
  registerMergeReadyStatusTool(pi, { getStatus: getCurrentStatusReader, normalizeUrl });
}

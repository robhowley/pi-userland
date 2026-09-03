import { registerMergeReadyCommand, type MergeReadyCommandAPI } from './commands.js';
import {
  MERGE_READY_PROVIDER_COLLECTION_EVENT_V1,
  type MergeReadyProviderV1,
} from './provider-api.js';
import { getMergeReadyStatus, type MergeReadyStatusReader } from './merge-ready.js';
import { registerMergeReadyStatusBar, type MergeReadyStatusBarAPI } from './status-bar.js';
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
  MergeReadyProviderEvidenceV1,
  MergeReadyProviderPullRequestV1,
  MergeReadyProviderReadInputV1,
  MergeReadyProviderReadResultV1,
  MergeReadyProviderRemoteMatchV1,
  MergeReadyProviderRemoteV1,
  MergeReadyProviderSignalsV1,
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
    events?: { emit(channel: string, data: unknown): void };
  };

export default function (pi: MergeReadyExtensionAPI): void {
  let sessionProviders: readonly MergeReadyProviderV1[] = [];
  const getStatus: MergeReadyStatusReader = (options) =>
    getMergeReadyStatus({ ...options, providers: sessionProviders });

  pi.on('session_start', () => {
    const providers: MergeReadyProviderV1[] = [];
    pi.events?.emit(MERGE_READY_PROVIDER_COLLECTION_EVENT_V1, { providers });
    sessionProviders = [...providers];
  });

  registerMergeReadyStatusBar(pi, { getStatus });
  registerMergeReadyCommand(pi, { getStatus });
  registerMergeReadyStatusTool(pi, { getStatus });

  pi.on('session_shutdown', () => {
    sessionProviders = [];
  });
}

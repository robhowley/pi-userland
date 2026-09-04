import { registerMergeReadyCommand, type MergeReadyCommandAPI } from './commands.js';
import { MERGE_READY_PROVIDER_COLLECTION_EVENT, type MergeReadyProvider } from './provider-api.js';
import {
  createMergeReadyUrlStatusReader,
  getMergeReadyStatus,
  type MergeReadyStatusReader,
  type MergeReadyUrlStatusReaderFactory,
} from './merge-ready.js';
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
  MergeReadyProviderDetail,
  MergeReadyProviderEvidence,
  MergeReadyProviderPullRequest,
  MergeReadyProviderReadInput,
  MergeReadyProviderReadResult,
  MergeReadyProviderRemoteMatch,
  MergeReadyProviderRemote,
  MergeReadyProviderSignals,
  MergeReadyProviderUrlMatch,
  MergeReadyProvider,
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
  let sessionProviders: readonly MergeReadyProvider[] = [];
  const getStatus: MergeReadyStatusReader = (options) =>
    getMergeReadyStatus({ ...options, providers: sessionProviders });
  const createUrlStatusReader: MergeReadyUrlStatusReaderFactory = (options) =>
    createMergeReadyUrlStatusReader({ ...options, providers: sessionProviders });

  pi.on('session_start', () => {
    const providers: MergeReadyProvider[] = [];
    pi.events?.emit(MERGE_READY_PROVIDER_COLLECTION_EVENT, { providers });
    sessionProviders = [...providers];
  });

  registerMergeReadyStatusBar(pi, { getStatus });
  registerMergeReadyCommand(pi, { getStatus, createUrlStatusReader });
  registerMergeReadyStatusTool(pi, { getStatus });

  pi.on('session_shutdown', () => {
    sessionProviders = [];
  });
}

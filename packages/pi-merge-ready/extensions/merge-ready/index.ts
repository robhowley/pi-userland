import { registerMergeReadyCommand, type MergeReadyCommandAPI } from './commands.js';
import { registerMergeReadyStatusBar, type MergeReadyStatusBarAPI } from './status-bar.js';
import { registerMergeReadyStatusTool, type MergeReadyStatusToolAPI } from './tool.js';

export * from './types.js';
export * from './target.js';
export * from './status.js';
export * from './git.js';
export * from './github.js';
export * from './conversations.js';
export * from './merge-ready.js';
export * from './commands.js';
export * from './config.js';
export * from './status-bar.js';
export * from './tool.js';
export * from './watch.js';

export type MergeReadyExtensionAPI = MergeReadyCommandAPI &
  MergeReadyStatusBarAPI &
  MergeReadyStatusToolAPI;

export default function (pi: MergeReadyExtensionAPI): void {
  registerMergeReadyStatusBar(pi);
  registerMergeReadyCommand(pi);
  registerMergeReadyStatusTool(pi);
}

/**
 * Browser-safe launch-context presentation helpers shared by the iTerm2 web UI and TUI browser.
 * Keep server-owned launch semantics in worktree helpers; this file only owns labels and summary copy.
 */

/** @typedef {'ambient' | 'default' | 'custom'} LaunchAgentDirMode */

/** @type {readonly LaunchAgentDirMode[]} */
export const LAUNCH_AGENT_DIR_MODE_OPTIONS = Object.freeze(['ambient', 'default', 'custom']);

/**
 * @param {unknown} mode
 * @returns {string}
 */
export function formatLaunchAgentDirOptionLabel(mode) {
  switch (mode) {
    case 'default':
      return 'Pi default';
    case 'custom':
      return 'Custom…';
    default:
      return 'Current';
  }
}

/**
 * @param {unknown} mode
 * @returns {number}
 */
export function getLaunchAgentDirModeIndex(mode) {
  const index = LAUNCH_AGENT_DIR_MODE_OPTIONS.indexOf(mode);
  return index < 0 ? 0 : index;
}

/**
 * @param {unknown} preview
 * @returns {string}
 */
export function formatLaunchContextPreviewSummary(preview) {
  if (isResolvedLaunchContextPreview(preview)) {
    return `Pi config → ${preview.effectiveDisplay}`;
  }
  if (isLaunchContextPreviewStatus(preview, 'failed')) {
    return 'Pi config unavailable';
  }
  return 'Pi config resolving…';
}

/**
 * @param {unknown} preview
 * @returns {preview is { status: 'resolved'; effectiveDisplay: string }}
 */
function isResolvedLaunchContextPreview(preview) {
  return (
    isLaunchContextPreviewStatus(preview, 'resolved') &&
    typeof preview.effectiveDisplay === 'string' &&
    preview.effectiveDisplay.length > 0
  );
}

/**
 * @param {unknown} preview
 * @param {string} status
 * @returns {preview is { status: string; effectiveDisplay?: unknown }}
 */
function isLaunchContextPreviewStatus(preview, status) {
  return typeof preview === 'object' && preview !== null && preview.status === status;
}

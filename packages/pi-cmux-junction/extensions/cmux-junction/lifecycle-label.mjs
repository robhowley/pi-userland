/**
 * @param {string} state
 * @param {string | null} [toolName]
 * @returns {string | null}
 */
export function formatLifecycleLabel(state, toolName = null) {
  switch (state) {
    case 'compacting':
      return 'Compacting';
    case 'error':
      return 'Error';
    case 'awaiting-input':
      return 'Needs input';
    case 'tool-running':
      return toolName ? `Tool running: ${toolName}` : 'Tool running';
    case 'thinking':
      return 'Thinking';
    case 'unknown':
      return 'Unknown';
    case 'idle':
      return 'Idle';
    default:
      return null;
  }
}

import { describe, expect, it } from 'vitest';
import {
  LAUNCH_AGENT_DIR_MODE_OPTIONS,
  formatLaunchAgentDirOptionLabel,
  formatLaunchContextPreviewSummary,
  getLaunchAgentDirModeIndex,
} from '../../extensions/session-deck/iterm2/web/launch-context-view.js';

describe('launch-context view helpers', () => {
  it('defines selector order and labels once', () => {
    expect(LAUNCH_AGENT_DIR_MODE_OPTIONS).toEqual(['ambient', 'default', 'custom']);
    expect(LAUNCH_AGENT_DIR_MODE_OPTIONS.map(formatLaunchAgentDirOptionLabel)).toEqual([
      'Current',
      'Pi default',
      'Custom…',
    ]);
    expect(getLaunchAgentDirModeIndex('ambient')).toBe(0);
    expect(getLaunchAgentDirModeIndex('default')).toBe(1);
    expect(getLaunchAgentDirModeIndex('custom')).toBe(2);
    expect(getLaunchAgentDirModeIndex('unknown')).toBe(0);
  });

  it('formats launch preview summary copy', () => {
    expect(formatLaunchContextPreviewSummary({ status: 'loading' })).toBe('Pi config resolving…');
    expect(formatLaunchContextPreviewSummary({ ok: false, status: 'failed' })).toBe(
      'Pi config unavailable',
    );
    expect(
      formatLaunchContextPreviewSummary({
        ok: true,
        status: 'resolved',
        effectiveDisplay: '~/.pi/agent-or',
      }),
    ).toBe('Pi config → ~/.pi/agent-or');
  });
});

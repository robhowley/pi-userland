import { describe, expect, it } from 'vitest';

describe('pi-merge-ready', () => {
  it('exports an extension function', async () => {
    const module = await import('../../extensions/merge-ready/index.js');
    expect(typeof module.default).toBe('function');
  });

  it('exports merge_ready_status tool helpers', async () => {
    const module = await import('../../extensions/merge-ready/index.js');
    expect(module.MERGE_READY_STATUS_TOOL_NAME).toBe('merge_ready_status');
    expect(typeof module.registerMergeReadyStatusTool).toBe('function');
  });
});

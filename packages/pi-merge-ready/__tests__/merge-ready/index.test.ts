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

  it('exports the V1 provider helpers without private catalog internals', async () => {
    const module = await import('../../extensions/merge-ready/index.js');

    expect(typeof module.defineMergeReadyProvider).toBe('function');
    expect(typeof module.registerMergeReadyProvider).toBe('function');
    expect(module).not.toHaveProperty('MERGE_READY_PROVIDER_COLLECTION_EVENT_V1');
    expect(module).not.toHaveProperty('createMergeReadyProviderCatalog');
    expect(module).not.toHaveProperty('githubProvider');
    expect(module).not.toHaveProperty('BUILT_IN_MERGE_READY_PROVIDERS');
  });
});

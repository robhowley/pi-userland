import { describe, expect, it, vi } from 'vitest';
import {
  defineMergeReadyProvider,
  registerMergeReadyProvider,
  type MergeReadyProvider,
} from '../../extensions/merge-ready/index.js';
import { MERGE_READY_PROVIDER_COLLECTION_EVENT } from '../../extensions/merge-ready/provider-api.js';

function createProvider(id = 'gitlab'): MergeReadyProvider {
  return {
    id,
    matchUrl: () => null,
    matchRemote: () => null,
    read: async () => ({ kind: 'absent' }),
  };
}

function createEventBus() {
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  return {
    on: vi.fn((event: string, listener: (payload: unknown) => void) => {
      const eventListeners = listeners.get(event) ?? new Set();
      eventListeners.add(listener);
      listeners.set(event, eventListeners);
      return () => eventListeners.delete(listener);
    }),
    emit: vi.fn((event: string, payload: unknown) => {
      for (const listener of listeners.get(event) ?? []) listener(payload);
    }),
  };
}

describe('merge-ready public provider API', () => {
  it('defines a provider without wrapping or changing it', () => {
    const provider = createProvider();
    expect(defineMergeReadyProvider(provider)).toBe(provider);
  });

  it('collects synchronously and returns cleanup', () => {
    const events = createEventBus();
    const provider = createProvider();
    const unsubscribe = registerMergeReadyProvider(
      { events } as Parameters<typeof registerMergeReadyProvider>[0],
      provider,
    );
    const firstCollection: MergeReadyProvider[] = [];

    events.emit(MERGE_READY_PROVIDER_COLLECTION_EVENT, { providers: firstCollection });

    expect(firstCollection).toEqual([provider]);
    expect(unsubscribe()).toBe(true);
    expect(unsubscribe()).toBe(false);

    const afterCleanup: MergeReadyProvider[] = [];
    events.emit(MERGE_READY_PROVIDER_COLLECTION_EVENT, { providers: afterCleanup });
    expect(afterCleanup).toEqual([]);
  });

  it('ignores malformed collection payloads', () => {
    const events = createEventBus();
    registerMergeReadyProvider(
      { events } as Parameters<typeof registerMergeReadyProvider>[0],
      createProvider(),
    );

    expect(() => events.emit(MERGE_READY_PROVIDER_COLLECTION_EVENT, null)).not.toThrow();
    expect(() =>
      events.emit(MERGE_READY_PROVIDER_COLLECTION_EVENT, { providers: 'not-an-array' }),
    ).not.toThrow();
  });
});

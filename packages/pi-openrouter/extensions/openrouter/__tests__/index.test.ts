import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelOverridesFile } from '../models/types.js';

const { loadModelOverrides, saveModelOverrides } = vi.hoisted(() => ({
  loadModelOverrides: vi.fn<() => Promise<ModelOverridesFile>>(),
  saveModelOverrides: vi.fn(),
}));

vi.mock('../models/overrides.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../models/overrides.js')>();
  return {
    ...actual,
    loadModelOverrides,
    saveModelOverrides,
  };
});

import {
  applyNestedValue,
  handleModelOverrideClear,
  handleModelOverrideList,
  handleModelOverrideSet,
  parseScopedAssignment,
} from '../index.js';

const emptyOverrides = (): ModelOverridesFile => ({ version: 1, overrides: {} });

describe('parseScopedAssignment', () => {
  it('parses thinking shorthand aliases', () => {
    expect(parseScopedAssignment('thinking.high=high')).toEqual({
      fullPath: 'thinkingLevelMap.high',
      value: 'high',
    });
  });

  it('parses exact thinkingLevelMap field names', () => {
    expect(parseScopedAssignment('thinkingLevelMap.xhigh=max')).toEqual({
      fullPath: 'thinkingLevelMap.xhigh',
      value: 'max',
    });
  });

  it('parses null string values for thinking levels', () => {
    expect(parseScopedAssignment('thinking.off=null')).toEqual({
      fullPath: 'thinkingLevelMap.off',
      value: null,
    });
  });

  it('parses numeric and boolean top-level fields', () => {
    expect(parseScopedAssignment('contextWindow=64000')).toEqual({
      fullPath: 'contextWindow',
      value: 64000,
    });
    expect(parseScopedAssignment('maxTokens=8192')).toEqual({
      fullPath: 'maxTokens',
      value: 8192,
    });
    expect(parseScopedAssignment('reasoning=false')).toEqual({
      fullPath: 'reasoning',
      value: false,
    });
  });

  it('rejects malformed or unsupported assignments', () => {
    expect(parseScopedAssignment('thinking.high')).toBeNull();
    expect(parseScopedAssignment('unknown.field=value')).toBeNull();
    expect(parseScopedAssignment('contextWindow=large')).toBeNull();
    expect(parseScopedAssignment('reasoning=yes')).toBeNull();
  });
});

describe('applyNestedValue', () => {
  it('applies nested and top-level values', () => {
    const target: Record<string, unknown> = {};

    applyNestedValue(target, 'thinkingLevelMap.high', 'high');
    applyNestedValue(target, 'contextWindow', 64000);

    expect(target).toEqual({
      thinkingLevelMap: { high: 'high' },
      contextWindow: 64000,
    });
  });

  it('replaces non-object intermediate values with objects', () => {
    const target: Record<string, unknown> = { thinkingLevelMap: 'bad' };

    applyNestedValue(target, 'thinkingLevelMap.high', 'high');

    expect(target).toEqual({ thinkingLevelMap: { high: 'high' } });
  });
});

describe('handleModelOverrideSet', () => {
  beforeEach(() => {
    loadModelOverrides.mockReset();
    saveModelOverrides.mockReset();
    loadModelOverrides.mockResolvedValue(emptyOverrides());
    saveModelOverrides.mockResolvedValue(undefined);
  });

  it('returns usage when no model id is provided', async () => {
    const result = await handleModelOverrideSet('', emptyOverrides());

    expect(result.success).toBe(false);
    expect(result.message).toContain('Usage: /openrouter model-override-set');
    expect(saveModelOverrides).not.toHaveBeenCalled();
  });

  it('rejects model IDs without provider/model format', async () => {
    const result = await handleModelOverrideSet(
      'not-a-model contextWindow=64000',
      emptyOverrides(),
    );

    expect(result).toEqual({
      success: false,
      message:
        'Invalid model ID format: "not-a-model"\nExpected format: provider/model (e.g., "deepseek/deepseek-v4-pro")',
    });
    expect(saveModelOverrides).not.toHaveBeenCalled();
  });

  it('rejects missing field assignments', async () => {
    const result = await handleModelOverrideSet('test/model --dry-run', emptyOverrides());

    expect(result.success).toBe(false);
    expect(result.message).toContain('No field assignments provided');
    expect(saveModelOverrides).not.toHaveBeenCalled();
  });

  it('rejects invalid assignments', async () => {
    const result = await handleModelOverrideSet('test/model unknown=value', emptyOverrides());

    expect(result.success).toBe(false);
    expect(result.message).toContain('Invalid assignment: "unknown=value"');
    expect(saveModelOverrides).not.toHaveBeenCalled();
  });

  it('does not create thinkingLevelMap for non-thinking overrides', async () => {
    const userOverrides = emptyOverrides();

    const result = await handleModelOverrideSet('test/model contextWindow=64000', userOverrides);

    expect(result.success).toBe(true);
    expect(saveModelOverrides).toHaveBeenCalledWith({
      version: 1,
      overrides: {
        'test/model': {
          contextWindow: 64000,
        },
      },
    });
  });

  it('stores sparse thinking overrides without nulling unrelated levels', async () => {
    const userOverrides = emptyOverrides();

    const result = await handleModelOverrideSet('test/model thinking.high=high', userOverrides);

    expect(result.success).toBe(true);
    expect(saveModelOverrides).toHaveBeenCalledWith({
      version: 1,
      overrides: {
        'test/model': {
          thinkingLevelMap: {
            high: 'high',
          },
        },
      },
    });
  });

  it('persists all supported field types in one command', async () => {
    const userOverrides = emptyOverrides();

    const result = await handleModelOverrideSet(
      'test/model thinking.high=high thinking.xhigh=max thinking.off=null contextWindow=64000 maxTokens=8192 reasoning=true',
      userOverrides,
    );

    expect(result).toMatchObject({ success: true, modelId: 'test/model' });
    expect(result.message).toContain('Saved overrides for test/model');
    expect(saveModelOverrides).toHaveBeenCalledWith({
      version: 1,
      overrides: {
        'test/model': {
          thinkingLevelMap: {
            high: 'high',
            xhigh: 'max',
            off: null,
          },
          contextWindow: 64000,
          maxTokens: 8192,
          reasoning: true,
        },
      },
    });
  });

  it('merges with existing overrides instead of replacing them', async () => {
    const userOverrides: ModelOverridesFile = {
      version: 1,
      overrides: {
        'test/model': {
          thinkingLevelMap: { minimal: null, high: 'old-high' },
          contextWindow: 128000,
        },
      },
    };

    const result = await handleModelOverrideSet(
      'test/model thinking.high=high maxTokens=8192',
      userOverrides,
    );

    expect(result.success).toBe(true);
    expect(saveModelOverrides).toHaveBeenCalledWith({
      version: 1,
      overrides: {
        'test/model': {
          thinkingLevelMap: { minimal: null, high: 'high' },
          contextWindow: 128000,
          maxTokens: 8192,
        },
      },
    });
  });

  it('returns a handler failure when saving overrides fails', async () => {
    const userOverrides = emptyOverrides();
    saveModelOverrides.mockRejectedValue(new Error('disk full'));

    const result = await handleModelOverrideSet('test/model contextWindow=64000', userOverrides);

    expect(result).toEqual({
      success: false,
      message: 'Failed to save overrides for test/model: disk full',
    });
  });
});

describe('handleModelOverrideClear', () => {
  beforeEach(() => {
    saveModelOverrides.mockReset();
    saveModelOverrides.mockResolvedValue(undefined);
  });

  it('returns usage when no model id is provided', async () => {
    const result = await handleModelOverrideClear('', emptyOverrides());

    expect(result).toEqual({
      success: false,
      message: 'Usage: /openrouter model-override-clear <model-id>',
    });
    expect(saveModelOverrides).not.toHaveBeenCalled();
  });

  it('rejects model IDs without provider/model format', async () => {
    const result = await handleModelOverrideClear('bad-model', emptyOverrides());

    expect(result).toEqual({
      success: false,
      message: 'Invalid model ID format: "bad-model"\nExpected format: provider/model',
    });
    expect(saveModelOverrides).not.toHaveBeenCalled();
  });

  it('reports when the model has no overrides', async () => {
    const result = await handleModelOverrideClear('test/model', emptyOverrides());

    expect(result).toEqual({
      success: false,
      message: 'No overrides found for test/model',
    });
    expect(saveModelOverrides).not.toHaveBeenCalled();
  });

  it('removes an existing override and preserves other models', async () => {
    const userOverrides: ModelOverridesFile = {
      version: 1,
      overrides: {
        'test/model': { contextWindow: 64000 },
        'other/model': { maxTokens: 8192 },
      },
    };

    const result = await handleModelOverrideClear('test/model', userOverrides);

    expect(result).toEqual({
      success: true,
      message: 'Cleared all overrides for test/model',
      modelId: 'test/model',
    });
    expect(saveModelOverrides).toHaveBeenCalledWith({
      version: 1,
      overrides: {
        'other/model': { maxTokens: 8192 },
      },
    });
  });

  it('returns a handler failure when clearing overrides fails', async () => {
    const userOverrides: ModelOverridesFile = {
      version: 1,
      overrides: {
        'test/model': {
          contextWindow: 64000,
        },
      },
    };
    saveModelOverrides.mockRejectedValue(new Error('permission denied'));

    const result = await handleModelOverrideClear('test/model', userOverrides);

    expect(result).toEqual({
      success: false,
      message: 'Failed to clear overrides for test/model: permission denied',
    });
  });
});

describe('handleModelOverrideList', () => {
  beforeEach(() => {
    loadModelOverrides.mockReset();
    loadModelOverrides.mockResolvedValue(emptyOverrides());
  });

  it('lists available fields', async () => {
    const result = await handleModelOverrideList('--fields');

    expect(result).toContain('Available override fields:');
    expect(result).toContain('thinking.high: thinkingLevelMap.high (string)');
    expect(result).toContain('contextWindow: contextWindow (number)');
    expect(result).toContain('reasoning: reasoning (boolean)');
  });

  it('shows an empty state when no overrides exist', async () => {
    const result = await handleModelOverrideList('');

    expect(result).toBe(
      'No model overrides configured.\nUse /openrouter model-override-set to add overrides.',
    );
  });

  it('reports a missing specific model override', async () => {
    loadModelOverrides.mockResolvedValue({
      version: 1,
      overrides: {
        'other/model': { maxTokens: 8192 },
      },
    });

    const result = await handleModelOverrideList('test/model');

    expect(result).toBe('No overrides configured for test/model');
  });

  it('formats a specific model override with nested thinking values', async () => {
    loadModelOverrides.mockResolvedValue({
      version: 1,
      overrides: {
        'test/model': {
          thinkingLevelMap: { off: null, high: 'high', xhigh: 'max' },
          contextWindow: 64000,
          maxTokens: 8192,
          reasoning: true,
        },
      },
    });

    const result = await handleModelOverrideList('test/model');

    expect(result).toBe(
      [
        'Overrides for test/model:',
        '  thinkingLevelMap:',
        '    off: null',
        '    high: high',
        '    xhigh: max',
        '  contextWindow: 64000',
        '  maxTokens: 8192',
        '  reasoning: true',
      ].join('\n'),
    );
  });

  it('lists all override model IDs and summarizes non-null thinking values', async () => {
    loadModelOverrides.mockResolvedValue({
      version: 1,
      overrides: {
        'thinking/model': {
          thinkingLevelMap: { off: null, high: 'high', xhigh: 'max' },
        },
        'top-level/model': {
          contextWindow: 64000,
        },
      },
    });

    const result = await handleModelOverrideList('');

    expect(result).toBe(
      [
        '2 model(s) with overrides:',
        '  thinking/model [high=high,xhigh=max]',
        '  top-level/model',
        '',
        'Use /openrouter model-override-list <model-id> for details',
      ].join('\n'),
    );
  });
});

// Phase 2: Session tagging integration tests
describe('addSessionIdToOpenRouterRequest', () => {
  // Need to dynamically import to get fresh module state
  beforeEach(async () => {
    vi.resetModules();
  });

  it('should add session_id to OpenRouter requests', async () => {
    const { addSessionIdToOpenRouterRequest } = await import('../index.js');

    const mockCtx = {
      sessionManager: {
        getSessionId: () => 'stable-session-123',
      },
    };

    const mockEvent = {
      type: 'before_provider_request',
      provider: 'openrouter',
      payload: {
        model: 'openrouter/anthropic/claude-sonnet-4',
        messages: [],
      },
    };

    const result = addSessionIdToOpenRouterRequest(mockEvent, mockCtx);

    expect(result).toBeDefined();
    expect(result?.['session_id']).toBe('pi:stable-session-123');
    expect(result?.['model']).toBe('openrouter/anthropic/claude-sonnet-4');
  });

  it('should return same session_id for multiple OpenRouter requests in same session', async () => {
    const { addSessionIdToOpenRouterRequest } = await import('../index.js');

    const mockCtx = {
      sessionManager: {
        getSessionId: () => 'stable-session-123',
      },
    };

    const mockEvent1 = {
      provider: 'openrouter',
      payload: { model: 'openrouter/model-1', messages: [] },
    };

    const mockEvent2 = {
      provider: 'openrouter',
      payload: { model: 'openrouter/model-2', messages: [] },
    };

    const result1 = addSessionIdToOpenRouterRequest(mockEvent1, mockCtx);
    const result2 = addSessionIdToOpenRouterRequest(mockEvent2, mockCtx);

    expect(result1?.['session_id']).toBe('pi:stable-session-123');
    expect(result2?.['session_id']).toBe('pi:stable-session-123');
    expect(result1?.['session_id']).toBe(result2?.['session_id']);
  });

  it('should not overwrite existing session_id in payload', async () => {
    const { addSessionIdToOpenRouterRequest } = await import('../index.js');

    const mockCtx = {
      sessionManager: {
        getSessionId: () => 'new-session',
      },
    };

    const mockEvent = {
      provider: 'openrouter',
      payload: {
        model: 'openrouter/anthropic/claude-sonnet-4',
        messages: [],
        session_id: 'existing-session-id',
      },
    };

    const result = addSessionIdToOpenRouterRequest(mockEvent, mockCtx);

    // Should return undefined (no modification) when session_id exists
    expect(result).toBeUndefined();
    // Original payload should be unchanged
    expect(mockEvent.payload.session_id).toBe('existing-session-id');
  });

  it('should not tag non-OpenRouter requests', async () => {
    const { addSessionIdToOpenRouterRequest } = await import('../index.js');

    const mockCtx = {
      sessionManager: {
        getSessionId: () => 'my-session',
      },
    };

    const mockEvent = {
      provider: 'anthropic',
      payload: {
        model: 'claude-sonnet-4',
        messages: [],
      },
    };

    const result = addSessionIdToOpenRouterRequest(mockEvent, mockCtx);

    // Should return undefined (no modification) for non-OpenRouter
    expect(result).toBeUndefined();
  });

  it('should fail open when payload is missing', async () => {
    const { addSessionIdToOpenRouterRequest } = await import('../index.js');

    const mockCtx = {
      sessionManager: {
        getSessionId: () => 'my-session',
      },
    };

    const mockEvent = {
      provider: 'openrouter',
      // No payload
    };

    const result = addSessionIdToOpenRouterRequest(mockEvent, mockCtx);

    // Should return undefined (no modification) when payload missing
    expect(result).toBeUndefined();
  });

  it('should generate fallback UUID when session manager throws', async () => {
    const { addSessionIdToOpenRouterRequest } = await import('../index.js');

    const mockCtx = {
      sessionManager: {
        getSessionId: () => {
          throw new Error('Session manager error');
        },
      },
    };

    const mockEvent = {
      provider: 'openrouter',
      payload: {
        model: 'openrouter/model',
        messages: [],
      },
    };

    const result = addSessionIdToOpenRouterRequest(mockEvent, mockCtx);

    // Should generate a fallback UUID session_id
    expect(result).toBeDefined();
    expect(result?.['session_id']).toMatch(
      /^pi:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it('should fail open when payload getter throws', async () => {
    const { addSessionIdToOpenRouterRequest } = await import('../index.js');

    const mockCtx = {
      sessionManager: {
        getSessionId: () => 'my-session',
      },
    };

    // Create an event with a throwing payload getter
    const mockEvent = {
      provider: 'openrouter',
      get payload() {
        throw new Error('Payload getter error');
      },
    };

    // Should not throw and should return undefined
    const result = addSessionIdToOpenRouterRequest(mockEvent, mockCtx);
    expect(result).toBeUndefined();
  });
});

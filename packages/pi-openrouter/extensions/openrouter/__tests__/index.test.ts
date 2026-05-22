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

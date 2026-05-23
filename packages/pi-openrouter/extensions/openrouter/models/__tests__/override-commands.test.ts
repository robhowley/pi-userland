import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelOverridesFile } from '../types.js';

const { loadModelOverrides, saveModelOverrides } = vi.hoisted(() => ({
  loadModelOverrides: vi.fn<() => Promise<ModelOverridesFile>>(),
  saveModelOverrides: vi.fn(),
}));

vi.mock('../overrides.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../overrides.js')>();
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
  SCOPED_FIELD_MAP,
  validateThinkingValue,
} from '../override-commands.js';

const emptyOverrides = (): ModelOverridesFile => ({ version: 1, overrides: {} });

// =============================================================================
// Validation Tests
// =============================================================================

describe('validateThinkingValue', () => {
  it('accepts null (hide level signal)', () => {
    expect(validateThinkingValue(null)).toEqual({ valid: true });
  });

  it('accepts documented thinking values', () => {
    const validValues = ['off', 'minimal', 'low', 'medium', 'high', 'max', 'xhigh'];

    for (const value of validValues) {
      expect(validateThinkingValue(value)).toEqual({ valid: true });
    }
  });

  it('rejects empty string', () => {
    const result = validateThinkingValue('');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('empty');
  });

  it('rejects whitespace-only values', () => {
    const result = validateThinkingValue('   ');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('whitespace');
  });

  it('rejects control characters', () => {
    // Test null byte
    const result1 = validateThinkingValue('high\x00');
    expect(result1.valid).toBe(false);
    expect(result1.error).toContain('control');

    // Test bell character
    const result2 = validateThinkingValue('\x07high');
    expect(result2.valid).toBe(false);
    expect(result2.error).toContain('control');

    // Test DEL character
    const result3 = validateThinkingValue('high\x7F');
    expect(result3.valid).toBe(false);
    expect(result3.error).toContain('control');
  });

  it('rejects values not in the allowed set', () => {
    const result = validateThinkingValue('ultra-max-plus');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('not in the allowed set');
    expect(result.error).toContain('model-overrides.json');
  });

  it('rejects arbitrary string values', () => {
    const invalidValues = ['random', 'custom-value', '123', 'HIGH'];

    for (const value of invalidValues) {
      const result = validateThinkingValue(value);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('not in the allowed set');
    }
  });
});

// =============================================================================
// DSL Parsing Tests (Characterization + Validation)
// =============================================================================

describe('parseScopedAssignment', () => {
  describe('existing documented behavior', () => {
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

  describe('validation enforcement (Phase 7)', () => {
    it('rejects empty thinking values', () => {
      expect(parseScopedAssignment('thinking.high=')).toBeNull();
    });

    it('rejects whitespace-only thinking values', () => {
      expect(parseScopedAssignment('thinking.high=   ')).toBeNull();
    });

    it('rejects thinking values with control characters', () => {
      expect(parseScopedAssignment('thinking.high=high\x00')).toBeNull();
      expect(parseScopedAssignment('thinking.high=\x07high')).toBeNull();
    });

    it('rejects undocumented thinking values', () => {
      expect(parseScopedAssignment('thinking.high=ultra')).toBeNull();
      expect(parseScopedAssignment('thinking.high=custom-value')).toBeNull();
      expect(parseScopedAssignment('thinking.high=HIGH')).toBeNull();
    });

    it('accepts all documented thinking values', () => {
      const validPairs: Array<[string, string]> = [
        ['thinking.off=off', 'off'],
        ['thinking.minimal=minimal', 'minimal'],
        ['thinking.low=low', 'low'],
        ['thinking.medium=medium', 'medium'],
        ['thinking.high=high', 'high'],
        ['thinking.xhigh=max', 'max'],
        ['thinking.xhigh=xhigh', 'xhigh'],
      ];

      for (const [input, expectedValue] of validPairs) {
        const result = parseScopedAssignment(input);
        expect(result).not.toBeNull();
        expect(result?.value).toBe(expectedValue);
      }
    });

    it('does not validate non-thinking fields', () => {
      // contextWindow and other fields should not be affected by thinking validation
      expect(parseScopedAssignment('contextWindow=999999')).toEqual({
        fullPath: 'contextWindow',
        value: 999999,
      });
    });
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

// =============================================================================
// Command Handler Tests (Characterization)
// =============================================================================

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

  it('rejects invalid thinking values in assignments', async () => {
    const result = await handleModelOverrideSet(
      'test/model thinking.high=ultra-max',
      emptyOverrides(),
    );

    expect(result.success).toBe(false);
    expect(result.message).toContain('Invalid assignment: "thinking.high=ultra-max"');
    expect(saveModelOverrides).not.toHaveBeenCalled();
  });

  it('rejects empty thinking values in assignments', async () => {
    const result = await handleModelOverrideSet('test/model thinking.high=', emptyOverrides());

    expect(result.success).toBe(false);
    expect(result.message).toContain('Invalid assignment: "thinking.high="');
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

    expect(result.success).toBe(false);
    expect(result.message).toContain('Usage: /openrouter model-override-clear');
    expect(saveModelOverrides).not.toHaveBeenCalled();
  });

  it('rejects model IDs without provider/model format', async () => {
    const result = await handleModelOverrideClear('not-a-model', emptyOverrides());

    expect(result).toEqual({
      success: false,
      message: 'Invalid model ID format: "not-a-model"\nExpected format: provider/model',
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
      overrides: { 'test/model': { contextWindow: 64000 } },
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
  });

  it('lists available fields', async () => {
    loadModelOverrides.mockResolvedValue(emptyOverrides());

    const result = await handleModelOverrideList('--fields');

    expect(result).toContain('Available override fields');
    expect(result).toContain('thinking.high');
    expect(result).toContain('contextWindow');
  });

  it('shows an empty state when no overrides exist', async () => {
    loadModelOverrides.mockResolvedValue(emptyOverrides());

    const result = await handleModelOverrideList('');

    expect(result).toContain('No model overrides configured');
    expect(result).toContain('model-override-set');
  });

  it('reports a missing specific model override', async () => {
    loadModelOverrides.mockResolvedValue(emptyOverrides());

    const result = await handleModelOverrideList('test/model');

    expect(result).toBe('No overrides configured for test/model');
  });

  it('formats a specific model override with nested thinking values', async () => {
    loadModelOverrides.mockResolvedValue({
      version: 1,
      overrides: {
        'test/model': {
          thinkingLevelMap: { high: 'high', xhigh: 'max', off: null },
          contextWindow: 64000,
        },
      },
    });

    const result = await handleModelOverrideList('test/model');

    expect(result).toContain('Overrides for test/model');
    expect(result).toContain('thinkingLevelMap:');
    expect(result).toContain('high: high');
    expect(result).toContain('xhigh: max');
    expect(result).toContain('off: null');
    expect(result).toContain('contextWindow: 64000');
  });

  it('lists all override model IDs and summarizes non-null thinking values', async () => {
    loadModelOverrides.mockResolvedValue({
      version: 1,
      overrides: {
        'test/model1': { thinkingLevelMap: { high: 'high', off: null } },
        'test/model2': { contextWindow: 128000 },
      },
    });

    const result = await handleModelOverrideList('');

    expect(result).toContain('2 model(s) with overrides');
    expect(result).toContain('test/model1 [high=high]');
    expect(result).toContain('test/model2');
    expect(result).toContain('model-override-list <model-id>');
  });
});

// =============================================================================
// Field Map Tests (Characterization)
// =============================================================================

describe('SCOPED_FIELD_MAP', () => {
  it('includes all documented thinking shorthand aliases', () => {
    const expectedShorthands = [
      'thinking.off',
      'thinking.minimal',
      'thinking.low',
      'thinking.medium',
      'thinking.high',
      'thinking.xhigh',
    ];

    for (const shorthand of expectedShorthands) {
      expect(SCOPED_FIELD_MAP[shorthand]).toBeDefined();
      expect(SCOPED_FIELD_MAP[shorthand]?.targetType).toBe('string');
      expect(SCOPED_FIELD_MAP[shorthand]?.targetField).toContain('thinkingLevelMap');
    }
  });

  it('includes exact thinkingLevelMap field names', () => {
    const expectedExact = [
      'thinkingLevelMap.off',
      'thinkingLevelMap.minimal',
      'thinkingLevelMap.low',
      'thinkingLevelMap.medium',
      'thinkingLevelMap.high',
      'thinkingLevelMap.xhigh',
    ];

    for (const exact of expectedExact) {
      expect(SCOPED_FIELD_MAP[exact]).toBeDefined();
      expect(SCOPED_FIELD_MAP[exact]?.targetType).toBe('string');
      expect(SCOPED_FIELD_MAP[exact]?.targetField).toBe(exact);
    }
  });

  it('includes top-level extensibility fields', () => {
    expect(SCOPED_FIELD_MAP['contextWindow']).toEqual({
      targetField: 'contextWindow',
      targetType: 'number',
    });
    expect(SCOPED_FIELD_MAP['maxTokens']).toEqual({
      targetField: 'maxTokens',
      targetType: 'number',
    });
    expect(SCOPED_FIELD_MAP['reasoning']).toEqual({
      targetField: 'reasoning',
      targetType: 'boolean',
    });
  });
});

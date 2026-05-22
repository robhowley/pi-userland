import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelOverridesFile } from '../models/types.js';

const { saveModelOverrides } = vi.hoisted(() => ({
  saveModelOverrides: vi.fn(),
}));

vi.mock('../models/overrides.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../models/overrides.js')>();
  return {
    ...actual,
    saveModelOverrides,
  };
});

import {
  handleModelOverrideClear,
  handleModelOverrideSet,
  parseScopedAssignment,
} from '../index.js';

describe('parseScopedAssignment', () => {
  it('parses thinking shorthand aliases', () => {
    expect(parseScopedAssignment('thinking.high=high')).toEqual({
      fullPath: 'thinkingLevelMap.high',
      value: 'high',
    });
  });

  it('parses null string values for thinking levels', () => {
    expect(parseScopedAssignment('thinking.off=null')).toEqual({
      fullPath: 'thinkingLevelMap.off',
      value: null,
    });
  });
});

describe('handleModelOverrideSet', () => {
  beforeEach(() => {
    saveModelOverrides.mockReset();
    saveModelOverrides.mockResolvedValue(undefined);
  });

  it('does not create thinkingLevelMap for non-thinking overrides', async () => {
    const userOverrides: ModelOverridesFile = { version: 1, overrides: {} };

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
    const userOverrides: ModelOverridesFile = { version: 1, overrides: {} };

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

  it('returns a handler failure when saving overrides fails', async () => {
    const userOverrides: ModelOverridesFile = { version: 1, overrides: {} };
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

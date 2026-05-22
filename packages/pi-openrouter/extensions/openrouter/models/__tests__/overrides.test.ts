import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  loadModelOverrides,
  ModelOverridesLoadError,
  saveModelOverrides,
  setModelOverride,
  removeModelOverride,
  getModelOverride,
  getOverrideModelIds,
  hasOverrides,
} from '../overrides.js';
import type { ModelOverridesFile, UserModelOverride } from '../types.js';
import { existsSync } from 'node:fs';
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

// Mock node:fs
vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
}));

// Mock node:fs/promises
vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  mkdir: vi.fn(),
  rm: vi.fn(),
}));

// Mock node:os
vi.mock('node:os', () => ({
  homedir: vi.fn(),
}));

const OVERRIDES_FILE = join('/mock/home', '.pi', 'openrouter', 'model-overrides.json');

describe('overrides', () => {
  beforeEach(() => {
    vi.mocked(homedir).mockReturnValue('/mock/home');
    vi.mocked(existsSync).mockReturnValue(false);
    vi.mocked(readFile).mockRejectedValue(new Error('ENOENT'));
    vi.mocked(writeFile).mockResolvedValue(undefined);
    vi.mocked(mkdir).mockResolvedValue(undefined);
    vi.mocked(rm).mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('loadModelOverrides', () => {
    it('should return empty overrides when file does not exist', async () => {
      vi.mocked(existsSync).mockReturnValue(false);

      const result = await loadModelOverrides();

      expect(result).toEqual({ version: 1, overrides: {} });
    });

    it('should throw when file is invalid JSON', async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFile).mockResolvedValue('invalid json');

      await expect(loadModelOverrides()).rejects.toThrow(ModelOverridesLoadError);
      await expect(loadModelOverrides()).rejects.toThrow('Invalid JSON in model overrides file');
    });

    it('should throw when file has wrong structure', async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFile).mockResolvedValue(JSON.stringify({ foo: 'bar' }));

      await expect(loadModelOverrides()).rejects.toThrow(ModelOverridesLoadError);
      await expect(loadModelOverrides()).rejects.toThrow('Invalid model overrides file structure');
    });

    it('should throw when existing file cannot be read', async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFile).mockRejectedValue(new Error('permission denied'));

      await expect(loadModelOverrides()).rejects.toThrow(ModelOverridesLoadError);
      await expect(loadModelOverrides()).rejects.toThrow('Failed to read model overrides file');
    });

    it('should load valid overrides file', async () => {
      const mockData: ModelOverridesFile = {
        version: 1,
        overrides: {
          'test/model': {
            thinkingLevelMap: { high: 'high', xhigh: 'max' },
          },
        },
      };
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFile).mockResolvedValue(JSON.stringify(mockData));

      const result = await loadModelOverrides();

      expect(result).toEqual(mockData);
    });
  });

  describe('saveModelOverrides', () => {
    it('should create directory if it does not exist', async () => {
      vi.mocked(existsSync).mockReturnValue(false);

      const overrides: ModelOverridesFile = { version: 1, overrides: {} };
      await saveModelOverrides(overrides);

      expect(mkdir).toHaveBeenCalledWith(join('/mock/home', '.pi', 'openrouter'), {
        recursive: true,
      });
    });

    it('should write JSON to file', async () => {
      const overrides: ModelOverridesFile = {
        version: 1,
        overrides: {
          'test/model': {
            thinkingLevelMap: { high: 'high' },
          },
        },
      };

      await saveModelOverrides(overrides);

      expect(writeFile).toHaveBeenCalledWith(
        OVERRIDES_FILE,
        JSON.stringify(overrides, null, 2),
        'utf-8',
      );
    });
  });

  describe('getModelOverride', () => {
    it('should return undefined for unknown model', () => {
      const overrides: ModelOverridesFile = { version: 1, overrides: {} };

      const result = getModelOverride(overrides, 'unknown/model');

      expect(result).toBeUndefined();
    });

    it('should return override for known model', () => {
      const override: UserModelOverride = {
        thinkingLevelMap: { high: 'high' },
      };
      const overrides: ModelOverridesFile = {
        version: 1,
        overrides: { 'test/model': override },
      };

      const result = getModelOverride(overrides, 'test/model');

      expect(result).toEqual(override);
    });
  });

  describe('setModelOverride', () => {
    it('should add new override', () => {
      const overrides: ModelOverridesFile = { version: 1, overrides: {} };
      const override: UserModelOverride = {
        thinkingLevelMap: { high: 'high' },
      };

      const result = setModelOverride(overrides, 'test/model', override);

      expect(result.overrides['test/model']).toEqual({
        thinkingLevelMap: { high: 'high' },
      });
    });

    it('should merge with existing override', () => {
      const existing: UserModelOverride = {
        thinkingLevelMap: { minimal: null, high: 'low' },
        contextWindow: 128000,
      };
      const overrides: ModelOverridesFile = {
        version: 1,
        overrides: { 'test/model': existing },
      };

      const newOverride: UserModelOverride = {
        thinkingLevelMap: { high: 'high' },
        maxTokens: 8192,
      };

      const result = setModelOverride(overrides, 'test/model', newOverride);

      expect(result.overrides['test/model']).toEqual({
        thinkingLevelMap: { minimal: null, high: 'high' },
        contextWindow: 128000,
        maxTokens: 8192,
      });
    });

    it('should clean up undefined thinkingLevelMap entries', () => {
      const overrides: ModelOverridesFile = { version: 1, overrides: {} };
      const override: UserModelOverride = {
        thinkingLevelMap: { high: 'high', medium: undefined as unknown as null },
      };

      const result = setModelOverride(overrides, 'test/model', override);

      expect(result.overrides['test/model']?.thinkingLevelMap).toEqual({
        high: 'high',
      });
    });

    it('should remove empty thinkingLevelMap', () => {
      const overrides: ModelOverridesFile = { version: 1, overrides: {} };
      const override: UserModelOverride = {
        thinkingLevelMap: {},
        contextWindow: 128000,
      };

      const result = setModelOverride(overrides, 'test/model', override);

      expect(result.overrides['test/model']?.thinkingLevelMap).toBeUndefined();
      expect(result.overrides['test/model']?.contextWindow).toBe(128000);
    });

    it('should not create thinkingLevelMap for non-thinking overrides', () => {
      const overrides: ModelOverridesFile = { version: 1, overrides: {} };

      const result = setModelOverride(overrides, 'test/model', {
        contextWindow: 64000,
      });

      expect(result.overrides['test/model']).toEqual({
        contextWindow: 64000,
      });
    });
  });

  describe('removeModelOverride', () => {
    it('should remove existing override', () => {
      const overrides: ModelOverridesFile = {
        version: 1,
        overrides: {
          'test/model': { thinkingLevelMap: { high: 'high' } },
        },
      };

      const result = removeModelOverride(overrides, 'test/model');

      expect(result.overrides['test/model']).toBeUndefined();
      expect(Object.keys(result.overrides)).toHaveLength(0);
    });

    it('should be idempotent for non-existent model', () => {
      const overrides: ModelOverridesFile = {
        version: 1,
        overrides: {
          'other/model': { thinkingLevelMap: { high: 'high' } },
        },
      };

      const result = removeModelOverride(overrides, 'unknown/model');

      expect(result).toEqual(overrides);
    });
  });

  describe('getOverrideModelIds', () => {
    it('should return empty array when no overrides', () => {
      const overrides: ModelOverridesFile = { version: 1, overrides: {} };

      const result = getOverrideModelIds(overrides);

      expect(result).toEqual([]);
    });

    it('should return all model IDs with overrides', () => {
      const overrides: ModelOverridesFile = {
        version: 1,
        overrides: {
          'test/model1': {},
          'test/model2': {},
        },
      };

      const result = getOverrideModelIds(overrides);

      expect(result).toEqual(['test/model1', 'test/model2']);
    });
  });

  describe('hasOverrides', () => {
    it('should return false when no overrides', () => {
      const overrides: ModelOverridesFile = { version: 1, overrides: {} };

      expect(hasOverrides(overrides)).toBe(false);
    });

    it('should return true when overrides exist', () => {
      const overrides: ModelOverridesFile = {
        version: 1,
        overrides: { 'test/model': {} },
      };

      expect(hasOverrides(overrides)).toBe(true);
    });
  });
});

import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createChipTempPath,
  getChipRecordPath,
  getChipRuntimeDirectory,
  getChipsDirectory,
  isChipRecordFile,
  resolveChipId,
  resolveChipScope,
  validateChipIdSlug,
  validateChipScope,
  validateSourceSlug,
} from '../../extensions/session-deck/chips/store.js';

const HOME = '/home/user';
const RUNTIME_ID = 'rt-abc123';
const SOURCE = 'pi-merge-ready';
const CHIP_ID = 'current-pr';
const MOCK_UUID = '00000000-0000-4000-8000-000000000000';

describe('getChipsDirectory', () => {
  it('resolves under .pi/session-deck/chips', () => {
    const dir = getChipsDirectory(HOME);
    expect(dir).toBe(join(HOME, '.pi', 'session-deck', 'chips'));
  });
});

describe('getChipRuntimeDirectory', () => {
  it('appends runtimeId to the base chips dir', () => {
    const dir = getChipRuntimeDirectory(RUNTIME_ID, '/base');
    expect(dir).toBe('/base/rt-abc123');
  });
});

describe('getChipRecordPath', () => {
  it('returns correct file path', () => {
    const path = getChipRecordPath(SOURCE, CHIP_ID, 'session', RUNTIME_ID, '/base');
    expect(path).toBe('/base/rt-abc123/pi-merge-ready.current-pr.session.json');
  });
});

describe('createChipTempPath', () => {
  it('creates a temp path with UUID suffix', () => {
    const path = createChipTempPath(SOURCE, CHIP_ID, 'session', RUNTIME_ID, '/base', MOCK_UUID);
    expect(path).toBe(
      '/base/rt-abc123/.pi-merge-ready.current-pr.session.00000000-0000-4000-8000-000000000000.tmp',
    );
  });
});

describe('isChipRecordFile', () => {
  it('returns true for record files', () => {
    expect(isChipRecordFile('pi-merge-ready.current-pr.session.json')).toBe(true);
  });

  it('returns false for temp files starting with dot', () => {
    expect(isChipRecordFile('.pi-merge-ready.current-pr.session.mock-uuid.tmp')).toBe(false);
  });

  it('returns false for hidden json files', () => {
    expect(isChipRecordFile('.pi-merge-ready.current-pr.session.json')).toBe(false);
  });

  it('returns false for non-JSON extensions', () => {
    expect(isChipRecordFile('pi-merge-ready.txt')).toBe(false);
  });
});

describe('validateSourceSlug', () => {
  it('accepts valid slugs', () => {
    expect(validateSourceSlug('pi-merge-ready')).toEqual({ valid: true, value: 'pi-merge-ready' });
    expect(validateSourceSlug('pi-openrouter')).toEqual({ valid: true, value: 'pi-openrouter' });
  });

  it('rejects invalid slugs', () => {
    const result = validateSourceSlug('PI.READY');
    expect(result.valid).toBe(false);
  });
});

describe('validateChipIdSlug', () => {
  it('accepts valid chip IDs', () => {
    expect(validateChipIdSlug('default')).toEqual({ valid: true, value: 'default' });
    expect(validateChipIdSlug('current-pr')).toEqual({ valid: true, value: 'current-pr' });
  });

  it('rejects invalid chip IDs', () => {
    const result = validateChipIdSlug('chip.id');
    expect(result.valid).toBe(false);
  });
});

describe('validateChipScope', () => {
  it('accepts valid scopes', () => {
    expect(validateChipScope('session')).toEqual({ valid: true, value: 'session' });
    expect(validateChipScope('runtime')).toEqual({ valid: true, value: 'runtime' });
  });

  it('rejects invalid scopes', () => {
    const result = validateChipScope('invalid');
    expect(result.valid).toBe(false);
  });
});

describe('resolveChipId', () => {
  it('defaults to "default"', () => {
    expect(resolveChipId(undefined)).toBe('default');
  });

  it('passes through valid chipId', () => {
    expect(resolveChipId('health')).toBe('health');
  });
});

describe('resolveChipScope', () => {
  it('defaults to "session"', () => {
    expect(resolveChipScope(undefined)).toBe('session');
  });

  it('passes through valid scope', () => {
    expect(resolveChipScope('runtime')).toBe('runtime');
  });
});

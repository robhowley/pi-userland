import { describe, expect, it } from 'vitest';
import {
  ALLOWED_CHIP_LEVELS,
  ALLOWED_CHIP_SCOPES,
  CHIPS_SCHEMA_VERSION,
  DEFAULT_CHIP_ID,
  DEFAULT_CHIP_SCOPE,
  isValidChipIdSlug,
  isValidSourceSlug,
  validateChipScope,
} from '../../extensions/session-deck/chips/constants.js';

describe('CHIPS_SCHEMA_VERSION', () => {
  it('is 1', () => {
    expect(CHIPS_SCHEMA_VERSION).toBe(1);
  });
});

describe('DEFAULT_CHIP_ID', () => {
  it('is "default"', () => {
    expect(DEFAULT_CHIP_ID).toBe('default');
  });
});

describe('DEFAULT_CHIP_SCOPE', () => {
  it('is "session"', () => {
    expect(DEFAULT_CHIP_SCOPE).toBe('session');
  });
});

describe('ALLOWED_CHIP_SCOPES', () => {
  it('contains session and runtime', () => {
    expect(ALLOWED_CHIP_SCOPES).toEqual(['session', 'runtime']);
  });
});

describe('ALLOWED_CHIP_LEVELS', () => {
  it('contains all five levels', () => {
    expect(ALLOWED_CHIP_LEVELS).toEqual(['ok', 'info', 'warn', 'error', 'unknown']);
  });
});

describe('isValidSourceSlug', () => {
  it('accepts valid package names', () => {
    expect(isValidSourceSlug('pi-merge-ready')).toBe(true);
    expect(isValidSourceSlug('pi-openrouter')).toBe(true);
    expect(isValidSourceSlug('pi-session-hygiene')).toBe(true);
    expect(isValidSourceSlug('health')).toBe(true);
    expect(isValidSourceSlug('default')).toBe(true);
  });

  it('rejects empty string', () => {
    expect(isValidSourceSlug('')).toBe(false);
  });

  it('rejects dots', () => {
    expect(isValidSourceSlug('pi.merge')).toBe(false);
  });

  it('rejects slashes', () => {
    expect(isValidSourceSlug('pi/merge')).toBe(false);
  });

  it('rejects uppercase', () => {
    expect(isValidSourceSlug('PI-READY')).toBe(false);
  });

  it('rejects slugs longer than 64 chars', () => {
    expect(isValidSourceSlug('a'.repeat(65))).toBe(false);
  });

  it('rejects leading hyphen', () => {
    expect(isValidSourceSlug('-pi-merge')).toBe(false);
  });

  it('rejects trailing hyphen', () => {
    expect(isValidSourceSlug('pi-merge-')).toBe(false);
  });
});

describe('isValidChipIdSlug', () => {
  it('accepts "default"', () => {
    expect(isValidChipIdSlug('default')).toBe(true);
  });

  it('accepts "current-pr"', () => {
    expect(isValidChipIdSlug('current-pr')).toBe(true);
  });

  it('rejects empty string', () => {
    expect(isValidChipIdSlug('')).toBe(false);
  });

  it('rejects dots', () => {
    expect(isValidChipIdSlug('chip.id')).toBe(false);
  });
});

describe('validateChipScope', () => {
  it('accepts runtime and session', () => {
    expect(validateChipScope('session')).toEqual({ valid: true, value: 'session' });
    expect(validateChipScope('runtime')).toEqual({ valid: true, value: 'runtime' });
  });

  it('rejects invalid scopes', () => {
    const result = validateChipScope('bogus');
    expect(result.valid).toBe(false);
  });
});

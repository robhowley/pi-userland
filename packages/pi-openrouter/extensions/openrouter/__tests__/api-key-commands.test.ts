import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createApiKey: vi.fn(),
  setApiKeyDisabled: vi.fn(),
}));

vi.mock('../account-client.js', () => ({
  createApiKey: mocks.createApiKey,
  setApiKeyDisabled: mocks.setApiKeyDisabled,
}));

import {
  handleApiKeyCreate,
  handleApiKeyDisable,
  handleApiKeyEnable,
  isUtcIsoTimestamp,
  parseApiKeyCreateArgs,
} from '../api-key-commands.js';

describe('api-key-commands', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.createApiKey.mockResolvedValue({
      key: 'sk-or-v1-secret',
      keyInfo: {
        name: 'Team Key',
        hash: 'hash-123',
        disabled: false,
      },
    });
    mocks.setApiKeyDisabled.mockImplementation(async (hash: string, disabled: boolean) => ({
      name: disabled ? 'Disabled Key' : 'Enabled Key',
      hash,
      disabled,
    }));
  });

  describe('isUtcIsoTimestamp', () => {
    it('accepts canonical UTC ISO timestamps with or without milliseconds', () => {
      expect(isUtcIsoTimestamp('2026-06-01T00:00:00Z')).toBe(true);
      expect(isUtcIsoTimestamp('2026-06-01T00:00:00.000Z')).toBe(true);
    });

    it('rejects non-UTC or malformed timestamps', () => {
      expect(isUtcIsoTimestamp('2026-06-01T00:00:00+00:00')).toBe(false);
      expect(isUtcIsoTimestamp('2026-06-01')).toBe(false);
      expect(isUtcIsoTimestamp('wat')).toBe(false);
    });
  });

  describe('parseApiKeyCreateArgs', () => {
    it('parses create args and maps none/incl fields to SDK-friendly values', () => {
      const parsed = parseApiKeyCreateArgs(
        'team limit=none reset=weekly byok=incl workspace=ws-1 expires=2026-06-01T00:00:00Z',
      );

      expect(parsed).toEqual({
        ok: true,
        value: {
          name: 'team',
          limit: null,
          limitReset: 'weekly',
          includeByokInLimit: true,
          workspaceId: 'ws-1',
          expiresAt: new Date('2026-06-01T00:00:00Z'),
        },
      });
    });

    it('supports quoted key names with spaces', () => {
      const parsed = parseApiKeyCreateArgs('"Team Key" limit=10');

      expect(parsed).toEqual({
        ok: true,
        value: {
          name: 'Team Key',
          limit: 10,
        },
      });
    });

    it('rejects option-like first tokens because name is required', () => {
      const parsed = parseApiKeyCreateArgs('limit=25 reset=weekly');

      expect(parsed).toEqual({
        ok: false,
        message:
          'Usage: /openrouter api-key-create <name> [limit=<usd|none>] [reset=<daily|weekly|monthly|none>] [byok=<incl|excl>] [workspace=<id>] [expires=<UTC ISO>]',
      });
    });

    it('rejects invalid numeric limits', () => {
      const parsed = parseApiKeyCreateArgs('team limit=abc');

      expect(parsed).toEqual({
        ok: false,
        message: 'Invalid limit value: "abc"\nExpected a non-negative USD amount or \'none\'.',
      });
    });

    it('rejects invalid reset values', () => {
      const parsed = parseApiKeyCreateArgs('team reset=hourly');

      expect(parsed).toEqual({
        ok: false,
        message: 'Invalid reset value: "hourly"\nAllowed values: daily, weekly, monthly, none.',
      });
    });

    it('rejects invalid byok values', () => {
      const parsed = parseApiKeyCreateArgs('team byok=maybe');

      expect(parsed).toEqual({
        ok: false,
        message: 'Invalid byok value: "maybe"\nAllowed values: incl, excl.',
      });
    });

    it('rejects non-UTC expiry values', () => {
      const parsed = parseApiKeyCreateArgs('team expires=2026-06-01T00:00:00+00:00');

      expect(parsed).toEqual({
        ok: false,
        message:
          'Invalid expires value: "2026-06-01T00:00:00+00:00"\nExpected an ISO 8601 UTC timestamp ending in Z, for example 2026-06-01T00:00:00Z.',
      });
    });
  });

  describe('handleApiKeyCreate', () => {
    it('calls createApiKey with parsed args and returns the secret out-of-band exactly once', async () => {
      const result = await handleApiKeyCreate(
        'team limit=25.5 reset=none byok=excl workspace=ws-9 expires=2026-06-01T00:00:00Z',
      );

      expect(mocks.createApiKey).toHaveBeenCalledWith({
        name: 'team',
        limit: 25.5,
        limitReset: null,
        includeByokInLimit: false,
        workspaceId: 'ws-9',
        expiresAt: new Date('2026-06-01T00:00:00Z'),
      });
      expect(result.success).toBe(true);
      expect(result.message).toContain('OpenRouter API key created');
      expect(result.message).toContain('Secret shown in secure overlay; store it now.');
      expect(result.message).toContain('Warning: This secret cannot be recovered');
      expect(result.message).not.toContain('sk-or-v1-secret');
      expect(result.secret).toBe('sk-or-v1-secret');
    });

    it('returns validation failures before calling account-client helpers', async () => {
      const result = await handleApiKeyCreate('team limit=-1');

      expect(mocks.createApiKey).not.toHaveBeenCalled();
      expect(result).toEqual({
        success: false,
        message: 'Invalid limit value: "-1"\nExpected a non-negative USD amount or \'none\'.',
      });
    });

    it('surfaces helper errors as failure messages', async () => {
      mocks.createApiKey.mockRejectedValue(
        new Error('Management key required to create API keys.'),
      );

      const result = await handleApiKeyCreate('team');

      expect(result).toEqual({
        success: false,
        message: 'Management key required to create API keys.',
      });
    });
  });

  describe('handleApiKeyDisable / handleApiKeyEnable', () => {
    it('disables a key by hash and formats the success message', async () => {
      const result = await handleApiKeyDisable('hash-disable');

      expect(mocks.setApiKeyDisabled).toHaveBeenCalledWith('hash-disable', true);
      expect(result).toEqual({
        success: true,
        message:
          'OpenRouter API key disabled\nName: Disabled Key\nHash: hash-disable\nStatus: disabled\nRun /openrouter account to verify.',
      });
    });

    it('enables a key by hash and formats the success message', async () => {
      const result = await handleApiKeyEnable('hash-enable');

      expect(mocks.setApiKeyDisabled).toHaveBeenCalledWith('hash-enable', false);
      expect(result).toEqual({
        success: true,
        message:
          'OpenRouter API key enabled\nName: Enabled Key\nHash: hash-enable\nStatus: enabled\nRun /openrouter account to verify.',
      });
    });

    it('requires exactly one hash argument', async () => {
      const result = await handleApiKeyDisable('');
      const resultWithExtra = await handleApiKeyEnable('hash extra');

      expect(mocks.setApiKeyDisabled).not.toHaveBeenCalled();
      expect(result).toEqual({
        success: false,
        message: 'Usage: /openrouter api-key-disable <hash>',
      });
      expect(resultWithExtra).toEqual({
        success: false,
        message: 'Usage: /openrouter api-key-enable <hash>',
      });
    });
  });
});

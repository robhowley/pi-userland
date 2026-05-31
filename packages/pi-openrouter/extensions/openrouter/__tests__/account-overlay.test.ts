import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Theme } from '@mariozechner/pi-coding-agent';
import type { KeyInfo, RollupStatus } from '../account-types.js';

const tuiMocks = vi.hoisted(() => ({
  matchesKey: vi.fn(),
}));

const accountClientMocks = vi.hoisted(() => ({
  getAllKeys: vi.fn(),
  getCurrentKey: vi.fn(),
  getAccountCredits: vi.fn(),
  setApiKeyDisabled: vi.fn(),
}));

vi.mock('@mariozechner/pi-tui', () => ({
  matchesKey: tuiMocks.matchesKey,
  truncateToWidth: (text: string) => text,
}));

vi.mock('../account-client.js', () => ({
  getAllKeys: accountClientMocks.getAllKeys,
  getCurrentKey: accountClientMocks.getCurrentKey,
  getAccountCredits: accountClientMocks.getAccountCredits,
  setApiKeyDisabled: accountClientMocks.setApiKeyDisabled,
}));

import { AccountOverlayComponent } from '../account-overlay.js';

function createIdentityTheme(): Theme {
  return {
    bold: (text: string) => text,
    fg: (_style: string, text: string) => text,
  } as Theme;
}

function createKey(overrides: Partial<KeyInfo> = {}): KeyInfo {
  return {
    name: 'Primary',
    label: 'sk-or-v1-123',
    status: 'healthy',
    used: 10,
    remaining: 90,
    limit: 100,
    resetCadence: 'monthly',
    byok: 'incl',
    hash: 'hash-1',
    disabled: false,
    workspaceName: 'Main Workspace',
    spend: 10,
    ...overrides,
  };
}

function renderText(component: AccountOverlayComponent): string {
  return component.render(120).join('\n');
}

function installSimpleKeyMatcher(): void {
  tuiMocks.matchesKey.mockImplementation((data: string, key: string) => {
    if ((key === 'enter' || key === 'return') && data === 'enter') {
      return true;
    }
    return data === key;
  });
}

describe('AccountOverlayComponent', () => {
  const components: AccountOverlayComponent[] = [];
  const rollupStatus: RollupStatus = { status: 'healthy', message: '🔴 0  🟡 0  🟢 2' };

  beforeEach(() => {
    vi.clearAllMocks();
    installSimpleKeyMatcher();
  });

  afterEach(() => {
    for (const component of components) {
      component.dispose();
    }
    components.length = 0;
  });

  it('does not render internal hashes and advertises toggle in the footer', () => {
    const longHash = '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const component = new AccountOverlayComponent(
      [
        createKey({ name: 'Primary', hash: 'hash-primary', spend: 20 }),
        createKey({ name: 'Automation', hash: longHash, spend: 5, label: 'sk-or-v1-999' }),
      ],
      25,
      rollupStatus,
      null,
      createIdentityTheme(),
      () => {},
      () => {},
    );
    components.push(component);

    const output = renderText(component);

    expect(output).not.toContain('hash      ');
    expect(output).not.toContain('hash-primary');
    expect(output).not.toContain(longHash);
    expect(output).toContain('t to toggle');
  });

  it('uses the selected key hash internally for t+enter and keeps that key selected after re-sort', async () => {
    accountClientMocks.setApiKeyDisabled.mockResolvedValue(
      createKey({
        name: 'Primary',
        hash: 'hash-primary',
        status: 'disabled',
        disabled: true,
        spend: 20,
      }),
    );

    const component = new AccountOverlayComponent(
      [
        createKey({ name: 'Primary', hash: 'hash-primary', spend: 20 }),
        createKey({ name: 'Automation', hash: 'hash-automation', spend: 5, label: 'sk-or-v1-999' }),
      ],
      25,
      rollupStatus,
      null,
      createIdentityTheme(),
      () => {},
      () => {},
    );
    components.push(component);

    component.handleInput('t');
    expect(renderText(component)).toContain('Press Enter to disable Primary');

    component.handleInput('enter');

    await vi.waitFor(() => {
      expect(accountClientMocks.setApiKeyDisabled).toHaveBeenCalledWith('hash-primary', true);
    });

    await vi.waitFor(() => {
      const output = renderText(component);
      expect(output).toContain('name      Primary');
      expect(output).toContain('status    disabled');
      expect(output).toContain('status    Primary disabled.');
      expect(output).not.toContain('hash-primary');
      expect(output).not.toContain('hash-automation');
    });
  });

  it('renders read-only when management key capabilities are unavailable', () => {
    const component = new AccountOverlayComponent(
      [createKey({ name: 'Primary', hash: 'hash-primary', spend: 20 })],
      25,
      rollupStatus,
      null,
      createIdentityTheme(),
      () => {},
      () => {},
      undefined,
      false,
    );
    components.push(component);

    expect(renderText(component)).toContain('readonly  Set OPENROUTER_MANAGEMENT_KEY');
    expect(renderText(component)).not.toContain('t to toggle');

    component.handleInput('t');

    expect(accountClientMocks.setApiKeyDisabled).not.toHaveBeenCalled();
    expect(renderText(component)).toContain('Set OPENROUTER_MANAGEMENT_KEY');
    expect(renderText(component)).not.toContain('hash-primary');
  });

  it('sanitizes failed toggle errors instead of rendering internal hashes', async () => {
    accountClientMocks.setApiKeyDisabled.mockRejectedValue(
      new Error('OpenRouter rejected hash-primary as invalid'),
    );

    const component = new AccountOverlayComponent(
      [createKey({ name: 'Primary', hash: 'hash-primary', spend: 20 })],
      25,
      rollupStatus,
      null,
      createIdentityTheme(),
      () => {},
      () => {},
    );
    components.push(component);

    component.handleInput('t');
    component.handleInput('enter');

    await vi.waitFor(() => {
      expect(accountClientMocks.setApiKeyDisabled).toHaveBeenCalledWith('hash-primary', true);
    });

    await vi.waitFor(() => {
      const output = renderText(component);
      expect(output).toContain('Failed to disable Primary');
      expect(output).not.toContain('hash-primary');
      expect(output).not.toContain('rejected hash-primary');
    });
  });
});

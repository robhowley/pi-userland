import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Theme } from '@mariozechner/pi-coding-agent';
import type { KeyInfo, RollupStatus } from '../account-types.js';

const tuiMocks = vi.hoisted(() => ({
  matchesKey: vi.fn(),
}));

vi.mock('@mariozechner/pi-tui', () => ({
  matchesKey: tuiMocks.matchesKey,
  truncateToWidth: (text: string) => text,
}));

vi.mock('../account-client.js', () => ({
  getAllKeys: vi.fn(),
  getCurrentKey: vi.fn(),
  getAccountCredits: vi.fn(),
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

function selectedKeyLines(lines: string[]): string[] {
  return lines.map((line) => line.trim()).filter((line) => line.includes('hash      '));
}

describe('AccountOverlayComponent', () => {
  const components: AccountOverlayComponent[] = [];
  const rollupStatus: RollupStatus = { status: 'healthy', message: '🔴 0  🟡 0  🟢 2' };

  beforeEach(() => {
    tuiMocks.matchesKey.mockReturnValue(false);
  });

  afterEach(() => {
    for (const component of components) {
      component.dispose();
    }
    components.length = 0;
  });

  it('shows the selected key hash and keeps long hashes visible after selection changes', () => {
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

    expect(selectedKeyLines(component.render(120))).toEqual([
      expect.stringContaining('hash      hash-primary'),
    ]);

    tuiMocks.matchesKey.mockImplementation(
      (data: string, key: string) => data === 'down' && key === 'down',
    );
    component.handleInput('down');

    const hashLine = selectedKeyLines(component.render(120)).find((line) => line.includes('hash'));
    expect(hashLine).toContain(longHash);
  });
});

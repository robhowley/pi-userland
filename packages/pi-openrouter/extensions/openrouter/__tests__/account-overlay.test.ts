import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Theme } from '@mariozechner/pi-coding-agent';
import type { CurrentKeyRelation, KeyInfo, RollupStatus } from '../account-types.js';

const tuiMocks = vi.hoisted(() => ({
  matchesKey: vi.fn(),
}));

const accountClientMocks = vi.hoisted(() => ({
  getAllKeys: vi.fn(),
  getCurrentKey: vi.fn(),
  resolveCurrentKeyRelation: vi.fn(),
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
  resolveCurrentKeyRelation: accountClientMocks.resolveCurrentKeyRelation,
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

function createInventoryMatchRelation(
  hash = 'hash-management',
  label = 'sk-or-v1-management',
): CurrentKeyRelation {
  return { kind: 'inventory-match', hash, label };
}

function createExternalProvisioningRelation(label = 'sk-or-v1-provisioning'): CurrentKeyRelation {
  return { kind: 'external-provisioning', label };
}

function createKeyInventory(
  keys: KeyInfo[] = [createKey()],
  options: { canManageKeys?: boolean; degradedReason?: string } = {},
) {
  return {
    keys,
    canManageKeys: options.canManageKeys ?? true,
    ...(options.degradedReason ? { degradedReason: options.degradedReason } : {}),
  };
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function createApiError(message: string, statusCode: number): Error & { statusCode: number } {
  return Object.assign(new Error(message), { name: 'ApiError', statusCode });
}

function createAuthError(message: string): Error & {
  name: string;
} {
  return Object.assign(new Error(message), { name: 'AuthError' });
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
    accountClientMocks.resolveCurrentKeyRelation.mockResolvedValue({
      kind: 'unresolved',
      reason: 'missing-current-key-match',
    });
  });

  afterEach(() => {
    for (const component of components) {
      component.dispose();
    }
    components.length = 0;
  });

  it('does not render internal hashes and advertises disable when the selected inventory row is mutable', () => {
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
      undefined,
      true,
      createInventoryMatchRelation('hash-management'),
    );
    components.push(component);

    const output = renderText(component);

    expect(output).not.toContain('hash      ');
    expect(output).not.toContain('hash-primary');
    expect(output).not.toContain(longHash);
    expect(output).toContain('t disable');
  });

  it('uses the selected key hash internally for t+enter and keeps that key selected after re-sort', async () => {
    const updatedState: Partial<KeyInfo> = {
      ...createKey({
        name: 'Primary',
        hash: 'hash-primary',
        status: 'disabled',
        disabled: true,
        spend: 20,
      }),
    };
    delete updatedState.workspaceName;
    accountClientMocks.setApiKeyDisabled.mockResolvedValue(updatedState);

    const component = new AccountOverlayComponent(
      [
        createKey({
          name: 'Primary',
          hash: 'hash-primary',
          spend: 20,
          workspaceName: 'Canonical Workspace',
        }),
        createKey({
          name: 'Automation',
          hash: 'hash-automation',
          spend: 5,
          label: 'sk-or-v1-999',
          workspaceName: 'Other Workspace',
        }),
      ],
      25,
      rollupStatus,
      null,
      createIdentityTheme(),
      () => {},
      () => {},
      undefined,
      true,
      createInventoryMatchRelation('hash-management'),
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
      expect(output).toContain('Canonical');
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
    expect(renderText(component)).not.toContain('·  t ');

    component.handleInput('t');

    expect(accountClientMocks.setApiKeyDisabled).not.toHaveBeenCalled();
    expect(renderText(component)).toContain('Set OPENROUTER_MANAGEMENT_KEY');
    expect(renderText(component)).not.toContain('hash-primary');
  });

  it('blocks toggles for rows without a trusted inventory hash', () => {
    const currentKey = createKey({ name: 'Current Key', spend: 20 });
    delete currentKey.hash;

    const component = new AccountOverlayComponent(
      [currentKey],
      25,
      rollupStatus,
      null,
      createIdentityTheme(),
      () => {},
      () => {},
      undefined,
      true,
      createInventoryMatchRelation('hash-management'),
    );
    components.push(component);

    expect(renderText(component)).toContain(
      'readonly  This row is not backed by key inventory metadata.',
    );
    expect(renderText(component)).not.toContain('·  t ');

    component.handleInput('t');

    expect(accountClientMocks.setApiKeyDisabled).not.toHaveBeenCalled();
    expect(renderText(component)).toContain('This row is not backed by key inventory metadata.');
  });

  it('blocks disabling keys until current management key identity exists', () => {
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

    expect(renderText(component)).toContain(
      'readonly  Cannot verify current key matches this row.',
    );
    expect(renderText(component)).not.toContain('·  t ');

    component.handleInput('t');

    expect(accountClientMocks.setApiKeyDisabled).not.toHaveBeenCalled();
    expect(renderText(component)).toContain('Cannot verify current key matches this row.');
  });

  it('allows disabling inventory rows when current auth is an external provisioning key', async () => {
    accountClientMocks.setApiKeyDisabled.mockResolvedValue(
      createKey({
        name: 'default-space-key',
        hash: 'hash-default-space',
        status: 'disabled',
        disabled: true,
        spend: 0,
        label: 'sk-or-v1-8ef...062',
      }),
    );

    const component = new AccountOverlayComponent(
      [
        createKey({
          name: 'default-space-key',
          hash: 'hash-default-space',
          label: 'sk-or-v1-8ef...062',
          spend: 20,
        }),
      ],
      25,
      rollupStatus,
      null,
      createIdentityTheme(),
      () => {},
      () => {},
      undefined,
      true,
      createExternalProvisioningRelation('sk-or-v1-4a0...459'),
    );
    components.push(component);

    expect(renderText(component)).toContain('t disable');
    expect(renderText(component)).not.toContain(
      'readonly  Cannot verify current key matches this row.',
    );

    component.handleInput('t');
    component.handleInput('enter');

    await vi.waitFor(() => {
      expect(accountClientMocks.setApiKeyDisabled).toHaveBeenCalledWith('hash-default-space', true);
    });
  });

  it('blocks disabling rows when multiple inventory keys match the current key label', () => {
    const component = new AccountOverlayComponent(
      [createKey({ name: 'Primary', hash: 'hash-primary', spend: 20 })],
      25,
      rollupStatus,
      null,
      createIdentityTheme(),
      () => {},
      () => {},
      undefined,
      true,
      {
        kind: 'ambiguous-label',
        label: 'sk-or-v1-123',
        matchingHashes: ['hash-primary', 'hash-secondary'],
      },
    );
    components.push(component);

    expect(renderText(component)).toContain('readonly  Multiple keys match the current key label.');
    expect(renderText(component)).not.toContain('·  t ');
  });

  it('allows enabling disabled keys even when current management key identity is unavailable', async () => {
    accountClientMocks.setApiKeyDisabled.mockResolvedValue(
      createKey({
        name: 'Disabled Key',
        hash: 'hash-disabled',
        status: 'healthy',
        disabled: false,
        spend: 5,
      }),
    );

    const component = new AccountOverlayComponent(
      [
        createKey({
          name: 'Disabled Key',
          hash: 'hash-disabled',
          status: 'disabled',
          disabled: true,
          spend: 0,
        }),
      ],
      25,
      rollupStatus,
      null,
      createIdentityTheme(),
      () => {},
      () => {},
    );
    components.push(component);

    expect(renderText(component)).toContain('t enable');

    component.handleInput('t');
    expect(renderText(component)).toContain('Press Enter to enable Disabled Key');

    component.handleInput('enter');

    await vi.waitFor(() => {
      expect(accountClientMocks.setApiKeyDisabled).toHaveBeenCalledWith('hash-disabled', false);
    });

    await vi.waitFor(() => {
      expect(renderText(component)).toContain('status    Disabled Key enabled.');
    });
  });

  it('blocks disabling the active management key when its identity is known', () => {
    const component = new AccountOverlayComponent(
      [createKey({ name: 'Primary', hash: 'hash-primary', spend: 20 })],
      25,
      rollupStatus,
      null,
      createIdentityTheme(),
      () => {},
      () => {},
      undefined,
      true,
      createInventoryMatchRelation('hash-primary', 'sk-or-v1-123'),
    );
    components.push(component);

    expect(renderText(component)).toContain('readonly  Cannot disable the active management key.');
    expect(renderText(component)).not.toContain('·  t ');

    component.handleInput('t');

    expect(accountClientMocks.setApiKeyDisabled).not.toHaveBeenCalled();
    expect(renderText(component)).toContain('Cannot disable the active management key.');
  });

  it('blocks close shortcuts while a toggle is pending', async () => {
    const toggle = createDeferred<Partial<KeyInfo>>();
    accountClientMocks.setApiKeyDisabled.mockReturnValue(toggle.promise);
    const onClose = vi.fn();

    const component = new AccountOverlayComponent(
      [createKey({ name: 'Primary', hash: 'hash-primary', spend: 20 })],
      25,
      rollupStatus,
      null,
      createIdentityTheme(),
      onClose,
      () => {},
      undefined,
      true,
      createInventoryMatchRelation('hash-management'),
    );
    components.push(component);

    component.handleInput('t');
    component.handleInput('enter');

    await vi.waitFor(() => {
      expect(accountClientMocks.setApiKeyDisabled).toHaveBeenCalledWith('hash-primary', true);
    });

    expect(renderText(component)).toContain('status    Disabling Primary...');

    component.handleInput('q');
    component.handleInput('ctrl+c');
    component.handleInput('escape');

    expect(onClose).not.toHaveBeenCalled();

    toggle.resolve({
      name: 'Primary',
      hash: 'hash-primary',
      status: 'disabled',
      disabled: true,
      spend: 20,
    });

    await vi.waitFor(() => {
      expect(renderText(component)).toContain('status    Primary disabled.');
    });

    component.handleInput('q');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('finalizes the toggle result even if the overlay is disposed while pending', async () => {
    const toggle = createDeferred<Partial<KeyInfo>>();
    accountClientMocks.setApiKeyDisabled.mockReturnValue(toggle.promise);

    const component = new AccountOverlayComponent(
      [createKey({ name: 'Primary', hash: 'hash-primary', spend: 20 })],
      25,
      rollupStatus,
      null,
      createIdentityTheme(),
      () => {},
      () => {},
      undefined,
      true,
      createInventoryMatchRelation('hash-management'),
    );
    components.push(component);

    component.handleInput('t');
    component.handleInput('enter');

    await vi.waitFor(() => {
      expect(accountClientMocks.setApiKeyDisabled).toHaveBeenCalledWith('hash-primary', true);
    });

    component.dispose();

    toggle.resolve({
      name: 'Primary',
      hash: 'hash-primary',
      status: 'disabled',
      disabled: true,
      spend: 20,
    });

    await vi.waitFor(() => {
      const output = renderText(component);
      expect(output).toContain('status    disabled');
      expect(output).toContain('status    Primary disabled.');
      expect((component as any).pendingToggleHash).toBeNull();
    });
  });

  it('does not fall back to current-key metadata on refresh when inventory is empty but manageable', async () => {
    accountClientMocks.getAllKeys.mockResolvedValue(
      createKeyInventory([], { canManageKeys: true }),
    );
    accountClientMocks.getAccountCredits.mockResolvedValue(25);
    accountClientMocks.getCurrentKey.mockResolvedValue(
      createKey({ name: 'Current', hash: 'hash-current' }),
    );

    const component = new AccountOverlayComponent(
      [createKey({ name: 'Primary', hash: 'hash-primary', spend: 20 })],
      25,
      rollupStatus,
      null,
      createIdentityTheme(),
      () => {},
      () => {},
      {} as any,
    );
    components.push(component);

    await component.refresh();

    expect(accountClientMocks.resolveCurrentKeyRelation).not.toHaveBeenCalled();
    expect(accountClientMocks.getCurrentKey).not.toHaveBeenCalled();
    expect(renderText(component)).toContain('No keys available');
    expect(renderText(component)).not.toContain('readonly  Set OPENROUTER_MANAGEMENT_KEY');
  });

  it('falls back to current-key metadata on refresh when management capability is degraded', async () => {
    accountClientMocks.getAllKeys.mockResolvedValue(
      createKeyInventory([], {
        canManageKeys: false,
        degradedReason: 'management-unavailable',
      }),
    );
    accountClientMocks.getAccountCredits.mockResolvedValue(25);
    accountClientMocks.getCurrentKey.mockResolvedValue(
      createKey({ name: 'Current', hash: 'hash-current', spend: 12 }),
    );

    const component = new AccountOverlayComponent(
      [createKey({ name: 'Primary', hash: 'hash-primary', spend: 20 })],
      25,
      rollupStatus,
      null,
      createIdentityTheme(),
      () => {},
      () => {},
      {} as any,
    );
    components.push(component);

    await component.refresh();

    expect(accountClientMocks.getCurrentKey).toHaveBeenCalledTimes(1);
    expect(renderText(component)).toContain('name      Current');
    expect(renderText(component)).toContain('readonly  Set OPENROUTER_MANAGEMENT_KEY');
  });

  it.each([400, 404])(
    'maps invalid or missing selected-key toggle errors (status %s) to refresh guidance without rendering internal hashes',
    async (statusCode) => {
      accountClientMocks.setApiKeyDisabled.mockRejectedValue(
        createApiError(
          statusCode === 400 ? 'OpenRouter rejected hash-primary as invalid' : 'Key not found',
          statusCode,
        ),
      );

      const component = new AccountOverlayComponent(
        [createKey({ name: 'Primary', hash: 'hash-primary', spend: 20 })],
        25,
        rollupStatus,
        null,
        createIdentityTheme(),
        () => {},
        () => {},
        undefined,
        true,
        createInventoryMatchRelation('hash-management'),
      );
      components.push(component);

      component.handleInput('t');
      component.handleInput('enter');

      await vi.waitFor(() => {
        expect(accountClientMocks.setApiKeyDisabled).toHaveBeenCalledWith('hash-primary', true);
      });

      await vi.waitFor(() => {
        expect((component as any).inlineMessage).toBe(
          'Failed to disable Primary: OpenRouter could not match the selected key. Refresh the account view and try again.',
        );
        const output = renderText(component);
        expect(output).not.toContain('hash-primary');
        expect(output).not.toContain('rejected hash-primary');
      });
    },
  );

  it.each([
    {
      title: 'management-key auth errors',
      error: createAuthError('Unauthorized'),
      expected:
        'Failed to disable Primary: Set OPENROUTER_MANAGEMENT_KEY to a valid management key, then refresh and try again.',
    },
    {
      title: 'management-key permission errors',
      error: createApiError('Forbidden', 403),
      expected:
        'Failed to disable Primary: OPENROUTER_MANAGEMENT_KEY does not have permission to update keys. Set it to a valid management key and refresh.',
    },
    {
      title: 'retryable rate-limit errors',
      error: createApiError('Too Many Requests', 429),
      expected:
        'Failed to disable Primary: OpenRouter could not update the selected key right now. Retry in a moment and refresh.',
    },
    {
      title: 'retryable service errors',
      error: createApiError('Service unavailable', 503),
      expected:
        'Failed to disable Primary: OpenRouter could not update the selected key right now. Retry in a moment and refresh.',
    },
  ])('maps $title to distinct inline guidance', async ({ error, expected }) => {
    accountClientMocks.setApiKeyDisabled.mockRejectedValue(error);

    const component = new AccountOverlayComponent(
      [createKey({ name: 'Primary', hash: 'hash-primary', spend: 20 })],
      25,
      rollupStatus,
      null,
      createIdentityTheme(),
      () => {},
      () => {},
      undefined,
      true,
      createInventoryMatchRelation('hash-management'),
    );
    components.push(component);

    component.handleInput('t');
    component.handleInput('enter');

    await vi.waitFor(() => {
      expect(accountClientMocks.setApiKeyDisabled).toHaveBeenCalledWith('hash-primary', true);
    });

    await vi.waitFor(() => {
      expect((component as any).inlineMessage).toBe(expected);
      const output = renderText(component);
      expect(output).not.toContain('hash-primary');
    });
  });
});

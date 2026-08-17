import { describe, expect, it, vi } from 'vitest';
import cmuxJunction from '../extensions/cmux-junction/index.js';

import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';

describe('pi-cmux-junction', () => {
  it('registers /junction and keeps the startup notification', () => {
    let sessionStart: ((event: unknown, ctx: ExtensionContext) => void) | undefined;
    const registerCommand = vi.fn();
    const pi = {
      registerCommand,
      on: vi.fn((event, handler) => {
        if (event === 'session_start') {
          sessionStart = handler;
        }
      }),
    } as unknown as ExtensionAPI;
    const notify = vi.fn();

    cmuxJunction(pi);
    sessionStart?.({ reason: 'startup' }, {
      ui: { notify },
    } as unknown as ExtensionContext);

    expect(registerCommand).toHaveBeenCalledWith(
      'junction',
      expect.objectContaining({
        description: expect.any(String),
        handler: expect.any(Function),
      }),
    );
    expect(notify).toHaveBeenCalledWith('Cmux Junction loaded', 'info');
  });
});

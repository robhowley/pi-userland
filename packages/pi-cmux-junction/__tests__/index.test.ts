import { describe, expect, it, vi } from 'vitest';
import cmuxJunction from '../extensions/cmux-junction/index.js';

import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';

describe('pi-cmux-junction', () => {
  it('announces when the extension loads', () => {
    let sessionStart: ((event: unknown, ctx: ExtensionContext) => void) | undefined;
    const pi = {
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

    expect(notify).toHaveBeenCalledWith('Cmux Junction loaded', 'info');
  });
});

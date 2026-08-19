import { describe, expect, it, vi } from 'vitest';
import cmuxJunction from '../extensions/cmux-junction/index.js';

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

describe('pi-cmux-junction', () => {
  it('registers /junction and lifecycle hooks without a startup notification', () => {
    const registerCommand = vi.fn();
    const on = vi.fn();
    const pi = { registerCommand, on } as unknown as ExtensionAPI;

    cmuxJunction(pi);

    expect(registerCommand).toHaveBeenCalledWith(
      'junction',
      expect.objectContaining({
        description: expect.any(String),
        getArgumentCompletions: expect.any(Function),
        handler: expect.any(Function),
      }),
    );
    const events = on.mock.calls.map(([event]) => event);
    expect(events).toEqual(
      expect.arrayContaining([
        'session_start',
        'input',
        'message_end',
        'turn_start',
        'tool_execution_start',
        'tool_execution_update',
        'tool_execution_end',
        'turn_end',
        'session_before_compact',
        'session_compact',
        'agent_settled',
        'session_shutdown',
      ]),
    );
    expect(events).not.toContain('agent_end');
  });
});

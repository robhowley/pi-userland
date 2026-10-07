import { describe, expect, it, vi } from 'vitest';
import { installJunctionBoard } from '../extensions/cmux-junction/board-install.js';
vi.mock('../extensions/cmux-junction/board-install.js', () => ({ installJunctionBoard: vi.fn() }));
import cmuxJunction from '../extensions/cmux-junction/index.js';

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

describe('pi-cmux-junction', () => {
  it('registers the producer view listener before existing wiring', () => {
    const registrationOrder: string[] = [];
    const registerCommand = vi.fn(() => {
      registrationOrder.push('command');
    });
    const on = vi.fn((event: string) => {
      registrationOrder.push(`lifecycle:${event}`);
    });
    let producerViewHandler: ((value: unknown) => void) | undefined;
    const eventsOn = vi.fn((channel: string, handler: (value: unknown) => void): (() => void) => {
      registrationOrder.push(`event:${channel}`);
      producerViewHandler = handler;
      return vi.fn();
    });
    const pi = {
      registerCommand,
      on,
      events: { on: eventsOn },
    } as unknown as ExtensionAPI;

    cmuxJunction(pi);
    expect(installJunctionBoard).not.toHaveBeenCalled();

    expect(eventsOn).toHaveBeenCalledTimes(1);
    expect(eventsOn).toHaveBeenCalledWith('pi-cmux-junction:update', expect.any(Function));
    expect(registrationOrder.slice(0, 3)).toEqual([
      'event:pi-cmux-junction:update',
      'command',
      'lifecycle:session_start',
    ]);
    expect(registerCommand).toHaveBeenCalledWith(
      'junction',
      expect.objectContaining({
        description: expect.any(String),
        getArgumentCompletions: expect.any(Function),
        handler: expect.any(Function),
      }),
    );
    const lifecycleEvents = on.mock.calls.map(([event]) => event as string);
    expect(lifecycleEvents).toEqual(
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
    expect(lifecycleEvents).not.toContain('agent_end');

    const handleProducerView = producerViewHandler;
    if (!handleProducerView) throw new Error('producer view handler was not registered');
    const registrations = registrationOrder.length;
    const validView = {
      producer: { key: 'worker', label: 'Worker' },
      items: [{ key: 'status', title: 'Status', rows: [{ value: 'ready' }] }],
    };
    const hostileValue = new Proxy(
      { producer: { key: 'hostile', label: 'Hostile' }, items: [] },
      {
        ownKeys() {
          throw new Error('hostile producer view');
        },
      },
    );

    expect(() => handleProducerView(validView)).not.toThrow();
    expect(() => handleProducerView(null)).not.toThrow();
    expect(() => handleProducerView(hostileValue)).not.toThrow();

    expect(registrationOrder).toHaveLength(registrations);
    expect(registerCommand).toHaveBeenCalledTimes(1);
  });
});

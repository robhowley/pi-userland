import { describe, expect, it, vi } from 'vitest';
import cmuxJunction from '../extensions/cmux-junction/index.js';

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

describe('pi-cmux-junction', () => {
  it('registers the producer board listener before existing wiring without side effects', () => {
    const registrationOrder: string[] = [];
    const registerCommand = vi.fn(() => {
      registrationOrder.push('command');
    });
    const on = vi.fn((event: string) => {
      registrationOrder.push(`lifecycle:${event}`);
    });
    const emit = vi.fn();
    let producerBoardHandler: ((value: unknown) => void) | undefined;
    const eventsOn = vi.fn((channel: string, handler: (value: unknown) => void): (() => void) => {
      registrationOrder.push(`event:${channel}`);
      producerBoardHandler = handler;
      return vi.fn();
    });
    const exec = vi.fn();
    const sendMessage = vi.fn();
    const appendEntry = vi.fn();
    const notify = vi.fn();
    const pi = {
      registerCommand,
      on,
      events: { emit, on: eventsOn },
      exec,
      sendMessage,
      appendEntry,
      ui: { notify },
    } as unknown as ExtensionAPI;

    cmuxJunction(pi);

    expect(eventsOn).toHaveBeenCalledTimes(1);
    expect(eventsOn).toHaveBeenCalledWith('pi-cmux-junction:update', expect.any(Function));
    expect(registrationOrder.slice(0, 3)).toEqual([
      'event:pi-cmux-junction:update',
      'command',
      'lifecycle:session_start',
    ]);
    expect(emit).not.toHaveBeenCalled();

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

    const handleProducerBoard = producerBoardHandler;
    if (!handleProducerBoard) throw new Error('producer board handler was not registered');
    const registrations = registrationOrder.length;
    const validBoard = {
      producer: { key: 'worker', label: 'Worker' },
      cards: [{ key: 'status', title: 'Status', rows: [{ value: 'ready' }] }],
    };
    const hostileValue = new Proxy(
      { producer: { key: 'hostile', label: 'Hostile' }, cards: [] },
      {
        ownKeys() {
          throw new Error('hostile producer board');
        },
      },
    );

    expect(() => handleProducerBoard(validBoard)).not.toThrow();
    expect(() => handleProducerBoard(null)).not.toThrow();
    expect(() => handleProducerBoard(hostileValue)).not.toThrow();

    expect(registrationOrder).toHaveLength(registrations);
    expect(eventsOn).toHaveBeenCalledTimes(1);
    expect(registerCommand).toHaveBeenCalledTimes(1);
    expect(on).toHaveBeenCalledTimes(lifecycleEvents.length);
    expect(emit).not.toHaveBeenCalled();
    expect(exec).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(appendEntry).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });
});

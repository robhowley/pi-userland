import { describe, expect, it } from 'vitest';
import {
  openIterm2TerminalForRuntime as commandOpenIterm2TerminalForRuntime,
  openTerminalForRuntime as commandOpenTerminalForRuntime,
} from '../../extensions/session-deck/identity/command.js';
import {
  openIterm2TerminalForRuntime,
  openTerminalForRuntime,
} from '../../extensions/session-deck/identity/open.js';

describe('identity open shared exports', () => {
  it('keeps command.ts as a re-export of the shared opener', () => {
    expect(commandOpenTerminalForRuntime).toBe(openTerminalForRuntime);
    expect(commandOpenIterm2TerminalForRuntime).toBe(openIterm2TerminalForRuntime);
  });
});

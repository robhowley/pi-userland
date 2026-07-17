import { describe, expect, it, vi } from 'vitest';

vi.mock('@mariozechner/pi-tui', () => ({
  matchesKey: (data: string, key: string) => data === key,
  truncateToWidth: (value: string, width: number) => value.slice(0, Math.max(0, width)),
  visibleWidth: (value: string) => value.length,
  wrapTextWithAnsi: (value: string) => [value],
}));

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

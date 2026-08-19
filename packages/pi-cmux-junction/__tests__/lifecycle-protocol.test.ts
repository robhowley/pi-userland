import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  LIFECYCLE_ACK_FIELDS,
  LIFECYCLE_ACK_KIND,
  LIFECYCLE_COMMON_FIELDS,
  LIFECYCLE_MESSAGE_KINDS,
  LIFECYCLE_PROTOCOL,
  LIFECYCLE_SNAPSHOT_FIELDS,
  LIFECYCLE_STATES,
  MAX_LIFECYCLE_FRAME_BYTES,
  MAX_LIFECYCLE_TOOL_NAME_LENGTH,
} from '../extensions/cmux-junction/lifecycle-protocol.mjs';

const fixturePath = new URL('../extensions/cmux-junction/wire-fixtures/v1.json', import.meta.url);
const fixtures = JSON.parse(await readFile(fixturePath, 'utf8'));

describe('shared lifecycle protocol facts', () => {
  it('describes the concrete v1 fixture envelopes', () => {
    const snapshot = fixtures.valid.find(
      (fixture: { name: string }) => fixture.name === 'initial idle snapshot',
    ).message;
    const goodbye = fixtures.valid.find(
      (fixture: { name: string }) => fixture.name === 'fenced goodbye',
    ).message;
    const ack = fixtures.validAcks[0].message;

    expect(fixtures.protocol).toBe(LIFECYCLE_PROTOCOL);
    expect(Object.keys(snapshot).sort()).toEqual([...LIFECYCLE_SNAPSHOT_FIELDS].sort());
    expect(Object.keys(goodbye).sort()).toEqual([...LIFECYCLE_COMMON_FIELDS].sort());
    expect(Object.keys(ack).sort()).toEqual([...LIFECYCLE_ACK_FIELDS].sort());
    expect(LIFECYCLE_MESSAGE_KINDS).toEqual(['snapshot', 'goodbye']);
    expect(ack.kind).toBe(LIFECYCLE_ACK_KIND);
  });

  it('keeps the v1 state, frame, and tool-name bounds explicit', () => {
    expect(LIFECYCLE_STATES).toEqual([
      'idle',
      'thinking',
      'tool-running',
      'awaiting-input',
      'compacting',
      'error',
      'unknown',
    ]);
    expect(MAX_LIFECYCLE_FRAME_BYTES).toBe(16 * 1024);
    expect(MAX_LIFECYCLE_TOOL_NAME_LENGTH).toBe(64);
  });
});

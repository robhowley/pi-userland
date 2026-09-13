import { describe, expect, it } from 'vitest';
import {
  createPresentationAck,
  createPresentationRejection,
  decodePresentationRequest,
  decodePresentationRequestLine,
  decodePresentationResponseLine,
  MAX_PRESENTATION_CONNECTION_ID_BYTES,
  MAX_PRESENTATION_IDENTITY_BYTES,
  MAX_PRESENTATION_ITEMS,
  MAX_PRESENTATION_PRODUCERS,
  MAX_PRESENTATION_REQUEST_LINE_BYTES,
  MAX_PRESENTATION_RESPONSE_LINE_BYTES,
  MAX_PRESENTATION_ROWS,
  PRESENTATION_ACK_FIELDS,
  PRESENTATION_COMMON_FIELDS,
  PRESENTATION_PROTOCOL,
  PRESENTATION_REJECTION_FIELDS,
  PRESENTATION_REJECTION_REASONS,
  PRESENTATION_SNAPSHOT_FIELDS,
} from '../extensions/cmux-junction/presentation-protocol.mjs';
import { normalizeProducerView } from '../extensions/cmux-junction/producer-view.js';

const hygieneView = {
  producer: { key: 'pi-session-hygiene', label: 'Session Hygiene' },
  items: [
    {
      key: 'session-hygiene',
      title: 'Session health',
      status: '🟡 ctx watch',
      rows: [],
    },
    {
      key: 'session-hygiene-cache',
      title: 'Cache',
      status: 'cache 80%',
      rows: [],
    },
  ],
};

function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    protocol: PRESENTATION_PROTOCOL,
    kind: 'snapshot',
    workspaceId: 'workspace-a',
    surfaceId: 'surface-a',
    sessionId: 'session-a',
    runtimeId: 'runtime-a',
    pid: 4321,
    processStartedAt: 1_700_000_000_000,
    connectionId: 'connection-a',
    sourceGeneration: null,
    revision: 0,
    views: [hygieneView],
    ...overrides,
  };
}

function goodbye(overrides: Record<string, unknown> = {}) {
  const message = snapshot({
    kind: 'goodbye',
    sourceGeneration: 7,
    revision: 1,
    ...overrides,
  });
  Reflect.deleteProperty(message, 'views');
  return message;
}

function fullView(index: number): {
  producer: { key: string; label: string };
  items: Array<{
    key: string;
    title: string;
    rows: Array<{ value: string; detail?: string }>;
  }>;
} {
  return {
    producer: { key: `producer-${String(index).padStart(2, '0')}`, label: 'P' },
    items: Array.from({ length: 8 }, (_, item) => ({
      key: `item-${item}`,
      title: 'T',
      rows: Array.from({ length: 8 }, () => ({ value: 'V' })),
    })),
  };
}

function exactSizeView(index: number) {
  const view = fullView(index);
  for (const item of view.items) {
    item.rows = item.rows.map(() => ({ value: 'V', detail: 'x' }));
  }
  let remaining = 8_192 - Buffer.byteLength(JSON.stringify(view), 'utf8');
  for (const item of view.items) {
    for (const row of item.rows) {
      const added = Math.min(remaining, 255);
      row.detail = `${row.detail ?? ''}${'x'.repeat(added)}`;
      remaining -= added;
    }
  }
  expect(remaining).toBe(0);
  expect(Buffer.byteLength(JSON.stringify(view), 'utf8')).toBe(8_192);
  return view;
}

describe('presentation request protocol', () => {
  it('freezes separate exact snapshot and goodbye envelopes without sentAt', () => {
    expect(PRESENTATION_PROTOCOL).toBe('pi-junction.presentation.v1');
    expect(PRESENTATION_PROTOCOL).not.toBe('pi-junction.lifecycle.v1');
    expect(PRESENTATION_SNAPSHOT_FIELDS).toEqual([...PRESENTATION_COMMON_FIELDS, 'views']);
    expect(PRESENTATION_SNAPSHOT_FIELDS).not.toContain('sentAt');

    const decoded = decodePresentationRequest(snapshot());
    expect(decoded.ok).toBe(true);
    if (!('value' in decoded)) return;
    expect(Object.keys(decoded.value).sort()).toEqual([...PRESENTATION_SNAPSHOT_FIELDS].sort());
    expect(Object.isFrozen(decoded.value)).toBe(true);
    expect(Object.isFrozen(decoded.value.views)).toBe(true);
    expect(Object.isFrozen(decoded.value.views[0].items[0].rows)).toBe(true);

    const decodedGoodbye = decodePresentationRequest(goodbye());
    expect(decodedGoodbye.ok).toBe(true);
    if ('value' in decodedGoodbye) {
      expect(Object.keys(decodedGoodbye.value).sort()).toEqual(
        [...PRESENTATION_COMMON_FIELDS].sort(),
      );
      expect(decodedGoodbye.value).not.toHaveProperty('views');
    }
  });

  it('copies a complete Session Hygiene-shaped normalized view', () => {
    const input = structuredClone(snapshot());
    const expected = structuredClone(input.views);
    const decoded = decodePresentationRequest(input);
    expect(decoded.ok).toBe(true);
    if (!('value' in decoded)) return;
    (input.views as (typeof hygieneView)[])[0]!.producer.label = 'mutated';
    expect(decoded.value.views).toEqual(expected);
    expect(decoded.value.views[0]).not.toBe((input.views as unknown[])[0]);
  });

  it.each([
    ['unknown request field', () => snapshot({ sentAt: 1 })],
    ['nullable goodbye generation', () => goodbye({ sourceGeneration: null })],
    ['empty producer items', () => snapshot({ views: [{ ...hygieneView, items: [] }] })],
    [
      'missing normalized rows',
      () => snapshot({ views: [{ ...hygieneView, items: [{ key: 'a', title: 'A' }] }] }),
    ],
    [
      'unknown nested field',
      () =>
        snapshot({
          views: [{ ...hygieneView, items: [{ key: 'a', title: 'A', rows: [], metadata: true }] }],
        }),
    ],
    ['duplicate producer key', () => snapshot({ views: [fullView(0), fullView(0)] })],
    ['unsorted producer keys', () => snapshot({ views: [fullView(1), fullView(0)] })],
    [
      'duplicate item key',
      () =>
        snapshot({
          views: [
            {
              producer: { key: 'p', label: 'P' },
              items: [
                { key: 'i', title: 'I', rows: [] },
                { key: 'i', title: 'I', rows: [] },
              ],
            },
          ],
        }),
    ],
    [
      'invalid nested URL',
      () =>
        snapshot({
          views: [
            {
              producer: { key: 'p', label: 'P' },
              items: [{ key: 'i', title: 'I', rows: [], href: 'http://example.com' }],
            },
          ],
        }),
    ],
  ])('rejects %s', (_name, candidate) => {
    expect(decodePresentationRequest(candidate()).ok).toBe(false);
  });

  it('tracks producer-view.ts nested grammar and per-view exact limits', () => {
    const exactItems = {
      producer: { key: 'producer', label: 'Producer' },
      items: Array.from({ length: 32 }, (_, index) => ({
        key: `item-${index}`,
        title: 'Item',
        rows: [],
      })),
    };
    const exactRowsPerItem = {
      producer: { key: 'producer', label: 'Producer' },
      items: [
        {
          key: 'item',
          title: 'Item',
          progress: { label: 'Complete', value: 1, max: 2 },
          rows: Array.from({ length: 16 }, () => ({
            label: 'Check',
            value: 'Passed',
            detail: 'Verified',
            href: 'https://example.com/check',
          })),
          href: 'https://example.com/item',
        },
      ],
    };
    const exactRowsPerView = {
      producer: { key: 'producer', label: 'Producer' },
      items: Array.from({ length: 16 }, (_, index) => ({
        key: `item-${index}`,
        title: 'Item',
        rows: Array.from({ length: 16 }, () => ({ value: 'Passed' })),
      })),
    };
    const cases: Array<[unknown, boolean]> = [
      [exactItems, true],
      [
        { ...exactItems, items: [...exactItems.items, { key: 'over', title: 'Item', rows: [] }] },
        false,
      ],
      [exactRowsPerItem, true],
      [
        {
          ...exactRowsPerItem,
          items: [
            {
              ...exactRowsPerItem.items[0],
              rows: [...exactRowsPerItem.items[0]!.rows, { value: 'Over' }],
            },
          ],
        },
        false,
      ],
      [exactRowsPerView, true],
      [
        {
          producer: exactRowsPerView.producer,
          items: [
            ...exactRowsPerView.items,
            {
              key: 'item-over',
              title: 'Item',
              rows: Array.from({ length: 16 }, () => ({ value: 'Passed' })),
            },
          ],
        },
        false,
      ],
      [
        {
          producer: { key: 'producer', label: 'Producer' },
          items: [{ key: 'item', title: 'Item', rows: [], unknown: true }],
        },
        false,
      ],
      [
        {
          producer: { key: 'producer', label: 'Producer' },
          items: [{ key: 'item', title: 'Item', rows: [], href: 'http://example.com' }],
        },
        false,
      ],
      [
        {
          producer: { key: 'producer', label: 'Producer' },
          items: [
            {
              key: 'item',
              title: 'Item',
              rows: [],
              progress: { label: 'Done', value: 2, max: 1 },
            },
          ],
        },
        false,
      ],
    ];

    for (const [candidate, accepted] of cases) {
      const normalized = normalizeProducerView(candidate);
      expect(normalized.ok).toBe(accepted);
      const transportCandidate = normalized.ok ? normalized.value : candidate;
      expect(decodePresentationRequest(snapshot({ views: [transportCandidate] })).ok).toBe(
        accepted,
      );
    }

    const exactBytes = exactSizeView(0);
    expect(decodePresentationRequest(snapshot({ views: [exactBytes] })).ok).toBe(true);
    const oneOver = structuredClone(exactBytes);
    const extensible = oneOver.items
      .flatMap((item) => item.rows)
      .find((row) => (row.detail?.length ?? 0) < 256);
    expect(extensible).toBeDefined();
    extensible!.detail = `${extensible!.detail ?? ''}x`;
    expect(Buffer.byteLength(JSON.stringify(oneOver), 'utf8')).toBe(8_193);
    expect(decodePresentationRequest(snapshot({ views: [oneOver] })).ok).toBe(false);
  });

  it('enforces UTF-8 identity and ASCII connection-ID exact boundaries', () => {
    expect(
      decodePresentationRequest(
        snapshot({ workspaceId: 'é'.repeat(MAX_PRESENTATION_IDENTITY_BYTES / 2) }),
      ).ok,
    ).toBe(true);
    expect(
      decodePresentationRequest(
        snapshot({ workspaceId: `${'é'.repeat(MAX_PRESENTATION_IDENTITY_BYTES / 2)}x` }),
      ).ok,
    ).toBe(false);
    expect(
      decodePresentationRequest(
        snapshot({ connectionId: 'x'.repeat(MAX_PRESENTATION_CONNECTION_ID_BYTES) }),
      ).ok,
    ).toBe(true);
    expect(
      decodePresentationRequest(
        snapshot({ connectionId: 'x'.repeat(MAX_PRESENTATION_CONNECTION_ID_BYTES + 1) }),
      ).ok,
    ).toBe(false);
  });

  it('accepts exact Phase-1 aggregate limits and rejects each one-over limit', () => {
    const views = Array.from({ length: MAX_PRESENTATION_PRODUCERS }, (_, index) => fullView(index));
    expect(views).toHaveLength(64);
    expect(views.flatMap((view) => view.items)).toHaveLength(MAX_PRESENTATION_ITEMS);
    expect(views.flatMap((view) => view.items.flatMap((item) => item.rows))).toHaveLength(
      MAX_PRESENTATION_ROWS,
    );
    expect(decodePresentationRequest(snapshot({ views })).ok).toBe(true);
    expect(decodePresentationRequest(snapshot({ views: [...views, fullView(64)] })).ok).toBe(false);

    const tooManyItems = structuredClone(views);
    tooManyItems[0]!.items.push({ key: 'item-8', title: 'T', rows: [] });
    expect(decodePresentationRequest(snapshot({ views: tooManyItems })).ok).toBe(false);

    const tooManyRows = structuredClone(views);
    tooManyRows[0]!.items[0]!.rows.push({ value: 'V' });
    expect(decodePresentationRequest(snapshot({ views: tooManyRows })).ok).toBe(false);
  });

  it('executes the maximum 64-view envelope and proves it fits 528 KiB', () => {
    const views = Array.from({ length: 64 }, (_, index) => exactSizeView(index));
    const line = JSON.stringify(snapshot({ views }));
    expect(Buffer.byteLength(JSON.stringify(views), 'utf8')).toBe(64 * 8_192 + 63 + 2);
    expect(Buffer.byteLength(line, 'utf8')).toBeLessThanOrEqual(
      MAX_PRESENTATION_REQUEST_LINE_BYTES,
    );
    expect(decodePresentationRequestLine(line).ok).toBe(true);
  });

  it('accepts exact request lines and rejects one byte over', () => {
    const base = JSON.stringify(snapshot({ views: [] }));
    const exact = base + ' '.repeat(MAX_PRESENTATION_REQUEST_LINE_BYTES - Buffer.byteLength(base));
    expect(decodePresentationRequestLine(exact).ok).toBe(true);
    expect(decodePresentationRequestLine(`${exact} `).ok).toBe(false);
  });
});

describe('presentation response protocol', () => {
  it('uses exact ACK and rejection fields and all seven rejection reasons', () => {
    const message = snapshot();
    const ack = createPresentationAck(message, 7);
    expect(Object.keys(ack).sort()).toEqual([...PRESENTATION_ACK_FIELDS].sort());
    expect(decodePresentationResponseLine(JSON.stringify(ack), message)).toEqual(ack);
    expect(PRESENTATION_REJECTION_REASONS).toEqual([
      'wrong-target',
      'fenced',
      'stale-revision',
      'dead-source',
      'source-limit',
      'identity-collision',
      'capacity',
    ]);
    for (const reason of PRESENTATION_REJECTION_REASONS) {
      const rejection = createPresentationRejection(message, reason);
      expect(Object.keys(rejection).sort()).toEqual([...PRESENTATION_REJECTION_FIELDS].sort());
      expect(decodePresentationResponseLine(JSON.stringify(rejection), message)).toEqual(rejection);
    }
  });

  it('requires exact echoed identity, generation, revision, kind, and fields', () => {
    const message = snapshot({ sourceGeneration: 7, revision: 4 });
    const ack = createPresentationAck(message, 7);
    const rejection = createPresentationRejection(message, 'fenced');
    for (const changed of [
      { ...ack, workspaceId: 'other' },
      { ...ack, acceptedRevision: 5 },
      { ...ack, acceptedKind: 'goodbye' },
      { ...ack, extra: true },
      { ...rejection, rejectedGeneration: 8 },
      { ...rejection, rejectedRevision: 5 },
      { ...rejection, reason: 'unknown' },
    ]) {
      expect(decodePresentationResponseLine(JSON.stringify(changed), message)).toBeNull();
    }
  });

  it('accepts exact response lines and rejects one byte over', () => {
    const message = snapshot();
    const base = JSON.stringify(createPresentationAck(message, 7));
    const exact = base + ' '.repeat(MAX_PRESENTATION_RESPONSE_LINE_BYTES - Buffer.byteLength(base));
    expect(decodePresentationResponseLine(exact, message)).not.toBeNull();
    expect(decodePresentationResponseLine(`${exact} `, message)).toBeNull();
  });
});

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { projectPresentationJ1 } from '../extensions/cmux-junction/presentation-j1.mjs';

const asset = fileURLToPath(
  new URL('../extensions/cmux-junction/sidebar/junction-board.swift', import.meta.url),
);
const directory = new URL('../extensions/cmux-junction/sidebar/fixtures/', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('manifest.json', directory), 'utf8')) as {
  cases: {
    filename: string;
    classification: string;
    visible: string[];
  }[];
};
type Node = {
  kind: string;
  text?: string;
  children: Node[];
  action?: unknown;
  value?: number;
  modifiers?: { name: string; args: { label?: string; value: string }[] }[];
};
const interpreter = process.env['JUNCTION_SWIFT_INTERPRETER'];
function fixture(filename: string) {
  return readFileSync(new URL(filename, directory), 'utf8');
}
function render(
  descriptions: (string | null)[],
  titles = descriptions.map((_, i) => `Workspace ${i}`),
): Node {
  const result = spawnSync(interpreter!, [asset], {
    input: JSON.stringify({
      workspaces: descriptions.map((description, i) => ({
        id: `w${i}`,
        title: titles[i] ?? `Workspace ${i}`,
        ...(description === null ? {} : { description }),
      })),
    }),
    encoding: 'utf8',
    timeout: 30000,
    maxBuffer: 4 * 1024 * 1024,
  });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  const node = JSON.parse(result.stdout) as Node;
  expect(node).not.toBeNull();
  expect(node.kind).toBe('vstack');
  return node;
}
function flatten(node: Node): Node[] {
  return [node, ...node.children.flatMap(flatten)];
}
function texts(node: Node) {
  return flatten(node).flatMap((n) => (n.text === undefined ? [] : [n.text]));
}

describe('fixed authored sidebar surface', () => {
  it('has only the authored HTTPS action and no external runtime operations', () => {
    const source = readFileSync(asset, 'utf8');
    expect(source.match(/openURL\(/gu)).toHaveLength(3);
    expect(source.match(/Button\("Open link"\) \{ openURL\(validatedHref\) \}/gu)).toHaveLength(2);
    expect(source.match(/Button\(action: \{ openURL\(validatedHref\) \}\)/gu)).toHaveLength(1);
    expect(source).not.toMatch(/\b(?:cmux|Process|FileHandle|URLSession|JSONDecoder|import)\s*\(/u);
    expect(readFileSync(asset).filter((byte) => byte === 13)).toHaveLength(4);
    expect(source).not.toMatch(/\.(?:background|border|overlay|fixedSize|lineLimit|padding)\(/u);
    expect(source).not.toMatch(/\b(?:Divider|DisclosureGroup)\s*\(/u);
  });
});

// This suite executes the pinned interpreter, never native Swift or a JS decoder.
// Explicitly skipped when the external JSON harness is unavailable; README gives its contract.
describe.skipIf(!interpreter)('pinned interpreted J2 behavior', () => {
  it.each([false, true])('renders status-only cards (link: %s)', (withLink) => {
    const projected = projectPresentationJ1([
      {
        sourceId: 'a'.repeat(64),
        producer: { key: 'health', label: 'Health' },
        items: [
          {
            key: 'health',
            status: 'Running',
            rows: [],
            ...(withLink ? { href: 'https://example.com/health' } : {}),
          },
        ],
      },
    ]);
    expect(projected.kind).toBe('set');
    if (projected.kind !== 'set') return;
    const node = render([projected.j1]);
    expect(texts(node)).toContain('Running');
    expect(texts(node)).not.toContain('Junction data unavailable');
    expect(texts(node)).not.toContain('\u001d');
    expect(flatten(node).filter((entry) => entry.kind === 'button')).toHaveLength(withLink ? 1 : 0);
  });
  for (const entry of manifest.cases) {
    it(entry.filename, () => {
      const node = render([fixture(entry.filename)]);
      const visible = texts(node);
      if (entry.classification === 'invalid' || entry.classification === 'ignored') {
        expect(visible).toEqual(entry.visible);
        return;
      }
      expect(visible[0]).toBe('Workspace 0');
      expect(visible).not.toContain('Junction data unavailable');
      // These legacy goldens describe producer-first order. Surface-first order
      // changes only these multi-source fixtures; keep exact content/order checks.
      const expected =
        entry.filename === 'two-sources.j2'
          ? [
              'Producer build',
              'Minimal card',
              'Producer zebra',
              'Last card',
              'Producer build',
              'Minimal card',
            ]
          : entry.filename === 'representative.j2'
            ? [
                'Producer build',
                'a build 0',
                'a build 1',
                'Producer checks',
                'a checks 0',
                'a checks 1',
                'Producer build',
                'b build 0',
                'b build 1',
                'Producer checks',
                'b checks 0',
                'b checks 1',
              ]
            : entry.visible;
      let cursor = 0;
      for (const text of expected) {
        const index = visible.indexOf(text, cursor);
        expect(index, `${text}: ${JSON.stringify(visible)}`).toBeGreaterThanOrEqual(cursor);
        cursor = index + 1;
      }
      expect(
        flatten(node).every((n) =>
          ['vstack', 'hstack', 'spacer', 'text', 'button', 'progressView'].includes(n.kind),
        ),
      ).toBe(true);
    });
  }
  for (const entry of manifest.cases.filter((entry) => entry.classification === 'invalid')) {
    for (const reversed of [false, true]) {
      it(`isolates ${entry.filename}, reversed=${reversed}`, () => {
        const descriptions = [fixture(entry.filename), fixture('minimal.j2')];
        if (reversed) descriptions.reverse();
        const visible = texts(render(descriptions));
        const valid = [
          `Workspace ${reversed ? 0 : 1}`,
          '(1)',
          'Unknown tab (source 1)',
          'Producer build',
          'Minimal card',
        ];
        expect(visible).toEqual(
          reversed
            ? [...valid, 'Junction data unavailable']
            : ['Junction data unavailable', ...valid],
        );
      });
    }
  }
  it.each(['other tab', 'userland tab'])(
    'groups two tabs and multiple producers without using labels as identity (%s)',
    (secondTitle) => {
      const summary =
        'A free-text summary that should wrap across the available width, never become a right-aligned metric. '.repeat(
          4,
        );
      const blocks = ['a', 'b'].flatMap((source, index) => [
        {
          sourceId: source.repeat(64),
          tab: {
            id: String(index + 1).repeat(64),
            label: index === 0 ? 'userland tab' : secondTitle,
          },
          producer: { key: 'merge-ready', label: 'Merge Ready' },
          items: [
            {
              key: 'pr',
              title: 'Current branch PR #210',
              href: 'https://example.com/pr/210',
              status: '✓ Ready',
              summary,
              rows: [],
            },
          ],
        },
        {
          sourceId: source.repeat(64),
          tab: {
            id: String(index + 1).repeat(64),
            label: index === 0 ? 'userland tab' : secondTitle,
          },
          producer: { key: 'session-hygiene', label: 'Session Hygiene' },
          items: [
            { key: 'health', title: 'Session health', status: '● ctx ok', rows: [] },
            { key: 'cache', title: 'Cache', summary: 'cache 97%', rows: [] },
          ],
        },
      ]);
      const projected = projectPresentationJ1(blocks);
      expect(projected.kind).toBe('set');
      if (projected.kind !== 'set') return;
      const node = render([projected.j1], ['userland root']);
      const visible = texts(node);
      const contents = [
        'Merge Ready',
        'Current branch PR #210',
        '✓ Ready',
        summary,
        'Session Hygiene',
        'Session health',
        '● ctx ok',
        'Cache',
        'cache 97%',
      ];
      expect(visible).toEqual([
        'userland root',
        '(2)',
        'userland tab',
        ...contents,
        secondTitle,
        ...contents,
      ]);
      const tabNodes = node.children.filter((entry) => entry.kind === 'vstack');
      expect(tabNodes).toHaveLength(2);
      for (const tab of tabNodes) {
        expect(tab.children[0]?.kind).toBe('spacer');
        expect(tab.children[0]?.modifiers).toContainEqual(
          expect.objectContaining({ name: 'frame', args: [{ label: 'height', value: '20' }] }),
        );
        const producers = tab.children[1]!.children.filter((entry) => entry.kind === 'hstack');
        expect(producers).toHaveLength(2);
        for (const producer of producers) {
          expect(producer.children[0]?.kind).toBe('spacer');
          expect(producer.children[0]?.modifiers).toContainEqual(
            expect.objectContaining({ name: 'frame', args: [{ label: 'width', value: '8' }] }),
          );
          for (const card of producer.children[1]!.children.filter(
            (entry) => entry.kind === 'hstack',
          )) {
            expect(card.children[0]?.kind).toBe('spacer');
            expect(card.children[0]?.modifiers).toContainEqual(
              expect.objectContaining({ name: 'frame', args: [{ label: 'width', value: '12' }] }),
            );
          }
        }
      }
      const summaries = flatten(node).filter((entry) => entry.text === summary);
      expect(summaries).toHaveLength(2);
      for (const entry of summaries) {
        expect(entry.modifiers).toContainEqual(
          expect.objectContaining({
            name: 'frame',
            args: [
              { label: 'maxWidth', value: '.infinity' },
              { label: 'alignment', value: '.leading' },
            ],
          }),
        );
        const card = flatten(node).find((parent) => parent.children.includes(entry));
        expect(card?.kind).toBe('vstack');
        expect(card?.children[1]?.text).toBe('✓ Ready');
        expect(card?.children[2]).toBe(entry);
        expect(
          entry.modifiers?.some((modifier) => ['lineLimit', 'fixedSize'].includes(modifier.name)),
        ).toBe(false);
      }
      expect(
        flatten(node)
          .filter((entry) => entry.kind === 'button')
          .map((entry) => texts(entry)),
      ).toEqual([['Current branch PR #210'], ['Current branch PR #210']]);
      expect(visible).not.toContain('Open link');
    },
  );

  it('uses legacy prefixes only for display and leaves structured producer labels intact', () => {
    const projected = projectPresentationJ1(
      ['a', 'b'].map((source, index) => ({
        sourceId: source.repeat(64),
        ...(index === 0 ? { tab: { id: '1'.repeat(64), label: 'userland tab' } } : {}),
        producer: {
          key: 'merge-ready',
          label: index === 0 ? 'Merge Ready · details' : 'other tab · Merge Ready',
        },
        items: [{ key: 'pr', title: `PR from ${source}`, rows: [] }],
      })),
    );
    expect(projected.kind).toBe('set');
    if (projected.kind !== 'set') return;
    expect(texts(render([projected.j1]))).toEqual([
      'Workspace 0',
      '(2)',
      'userland tab',
      'Merge Ready · details',
      'PR from a',
      'Unknown tab (source 2)',
      'Merge Ready',
      'PR from b',
    ]);
  });

  it('groups multiple lifecycle sources by durable surface identity while preserving every producer', () => {
    const projected = projectPresentationJ1(
      ['a', 'b'].map((source) => ({
        sourceId: source.repeat(64),
        tab: { id: '1'.repeat(64), label: 'Same surface' },
        producer: { key: 'merge-ready', label: 'Merge Ready' },
        items: [{ key: 'pr', title: `PR from ${source}`, rows: [] }],
      })),
    );
    expect(projected.kind).toBe('set');
    if (projected.kind !== 'set') return;
    expect(texts(render([projected.j1]))).toEqual([
      'Workspace 0',
      '(1)',
      'Same surface',
      'Merge Ready',
      'PR from a',
      'Merge Ready',
      'PR from b',
    ]);
  });

  it('keeps unnamed surfaces and legacy sources separate without losing cards', () => {
    const projected = projectPresentationJ1(
      ['a', 'b', 'c'].map((source, index) => ({
        sourceId: source.repeat(64),
        ...(index === 0 ? { tab: { id: '1'.repeat(64), label: null } } : {}),
        producer: { key: 'merge-ready', label: 'Merge Ready' },
        items: [{ key: 'pr', title: `PR from ${source}`, rows: [] }],
      })),
    );
    expect(projected.kind).toBe('set');
    if (projected.kind !== 'set') return;
    expect(texts(render([projected.j1]))).toEqual([
      'Workspace 0',
      '(3)',
      'Unnamed tab',
      'Merge Ready',
      'PR from a',
      'Unknown tab (source 2)',
      'Merge Ready',
      'PR from b',
      'Unknown tab (source 3)',
      'Merge Ready',
      'PR from c',
    ]);
  });

  it('rejects malformed source grouping metadata before rendering any content', () => {
    const source = `S\u001f0\u001f${'a'.repeat(64)}`;
    for (const suffix of [
      `\u001f${'1'.repeat(64)}\u001fbad\rtitle`,
      `\u001fnot-a-hash\u001ftab`,
      `\u001f${'1'.repeat(64)}`,
    ]) {
      expect(texts(render([fixture('minimal.j2').replace(source, source + suffix)]))).toEqual([
        'Junction data unavailable',
      ]);
    }
  });

  it('ignores absent descriptions without hiding the next workspace', () => {
    expect(texts(render([null, fixture('minimal.j2')]))).toEqual([
      'Workspace 1',
      '(1)',
      'Unknown tab (source 1)',
      'Producer build',
      'Minimal card',
    ]);
  });
  it('validates body semantics but treats a syntactically valid tag as opaque', () => {
    const wire = fixture('minimal.j2');
    expect(texts(render([wire.slice(0, 3) + '0'.repeat(64) + wire.slice(67)]))).toContain(
      'Minimal card',
    );
  });
  for (const control of [
    ...Array.from({ length: 32 }, (_, i) => String.fromCharCode(i)),
    ...Array.from({ length: 33 }, (_, i) => String.fromCharCode(i + 127)),
    '\r\n',
  ]) {
    for (const [position, title] of [
      control + 'x',
      'x' + control,
      'x' + control + 'y',
      control + '\u0301',
      '\u0600' + control,
      'x' + control + '\u0301y',
    ].entries()) {
      it(`rejects control beside marks ${JSON.stringify(control)}, position=${position}`, () => {
        expect(texts(render([fixture('minimal.j2').replace('Minimal card', title)]))).toEqual([
          'Junction data unavailable',
        ]);
      });
    }
  }
  it('rejects CRLF as well as individual controls', () => {
    expect(
      texts(render([fixture('minimal.j2').replace('Minimal card', 'before\r\nafter')])),
    ).toEqual(['Junction data unavailable']);
  });
  it('rejects control-containing hrefs without falling back partially', () => {
    expect(texts(render([fixture('url-control.j2')]))).toEqual(['Junction data unavailable']);
  });
  it('normalizes uppercase HTTPS before rendering a clickable action', () => {
    const projected = projectPresentationJ1([
      {
        sourceId: 'a'.repeat(64),
        producer: { key: 'build', label: 'Producer build' },
        items: [
          {
            key: 'task',
            title: 'Uppercase URL',
            href: 'HTTPS://EXAMPLE.COM:08443/path',
            rows: [],
          },
        ],
      },
    ]);
    expect(projected.kind).toBe('set');
    if (projected.kind !== 'set') return;
    const node = render([projected.j1]);
    expect(texts(node)).toContain('Uppercase URL');
    expect(
      flatten(node)
        .filter((entry) => entry.kind === 'button')
        .map((entry) => entry.action),
    ).toEqual([{ commands: [{ openURL: { _0: 'https://example.com:8443/path' } }] }]);
  });

  it('renders an approved item href on the item title', () => {
    const href = 'https://example.com/item';
    const projected = projectPresentationJ1([
      {
        sourceId: 'a'.repeat(64),
        producer: { key: 'build', label: 'Producer build' },
        items: [{ key: 'task', title: 'Linked item', href, rows: [] }],
      },
    ]);
    expect(projected.kind).toBe('set');
    if (projected.kind !== 'set') return;

    const node = render([projected.j1]);
    const buttons = flatten(node).filter((entry) => entry.kind === 'button');
    expect(buttons).toHaveLength(1);
    expect(texts(buttons[0]!)).toEqual(['Linked item']);
    expect(buttons[0]?.action).toEqual({
      commands: [{ openURL: { _0: href } }],
    });
    expect(texts(node)).not.toContain(href);
  });

  it('renders an item title plainly when href is absent', () => {
    const node = render([fixture('minimal.j2')]);
    expect(texts(node)).toContain('Minimal card');
    expect(flatten(node).filter((entry) => entry.kind === 'button')).toEqual([]);
  });

  it('keeps unsupported item href text and the row link action', () => {
    const cardHref = 'https://[::1]/card';
    const node = render([
      fixture('every-optional.j2').replace('https://example.com/card', cardHref),
    ]);
    const buttons = flatten(node).filter((entry) => entry.kind === 'button');

    expect(texts(node)).toContain(cardHref);
    expect(buttons).toHaveLength(1);
    expect(texts(buttons[0]!)).toEqual(['Open link']);
    expect(buttons[0]?.action).toEqual({
      commands: [{ openURL: { _0: 'https://example.com/row' } }],
    });
  });

  it('keeps a boundary Unicode href as text without losing its card or board', () => {
    const href = `https://example.com/${'é'.repeat(1014)}`;
    expect(Buffer.byteLength(href, 'utf8')).toBe(2_048);
    const projected = projectPresentationJ1([
      {
        sourceId: 'a'.repeat(64),
        producer: { key: 'build', label: 'Producer build' },
        items: [{ key: 'task', title: 'Boundary URL', href, rows: [] }],
      },
    ]);
    expect(projected.kind).toBe('set');
    if (projected.kind !== 'set') return;
    const node = render([projected.j1]);
    const visible = texts(node);
    expect(visible).toContain('Workspace 0');
    expect(visible).toContain('Boundary URL');
    expect(visible).toContain(href);
    expect(visible).not.toContain('Junction data unavailable');
    expect(flatten(node).filter((entry) => entry.kind === 'button')).toEqual([]);
  });

  it.each([
    ['IPv6 host', 'https://[::1]/card'],
    ['U+200D host', 'https://a\u200Db/card'],
    ['dangerous scheme', 'javascript:alert(1)'],
    ['malformed URL text', 'https://example.com/a b'],
    ['extra scheme', 'https://https://example.com/card'],
    ['extra scheme in port', 'https://example.com:https://444/card'],
    ['empty port', 'https://example.com:/card'],
  ])('shows %s href text without authorizing an action', (_name, href) => {
    const node = render([fixture('every-optional.j2').replace('https://example.com/card', href)]);
    const visible = texts(node);
    expect(visible).toEqual([
      'Workspace 0',
      '(1)',
      'Unknown tab (source 1)',
      'Producer build',
      'Every optional',
      'Running',
      'Summary',
      'Progress',
      '2.0',
      'Row label',
      'Row value',
      'Row detail',
      'Open link',
      'Unlabelled row',
      href,
      'Next card',
    ]);
    expect(
      flatten(node)
        .filter((entry) => entry.kind === 'button')
        .map((entry) => entry.action),
    ).toEqual([{ commands: [{ openURL: { _0: 'https://example.com/row' } }] }]);
  });

  it('keeps a scheme-looking path inside a safe URL action', () => {
    const href = 'https://example.com/path/https://nested';
    const nodes = flatten(
      render([fixture('every-optional.j2').replace('https://example.com/card', href)]),
    );
    expect(nodes.filter((entry) => entry.kind === 'button').map((entry) => entry.action)).toEqual([
      { commands: [{ openURL: { _0: href } }] },
      { commands: [{ openURL: { _0: 'https://example.com/row' } }] },
    ]);
  });

  it('preserves card and row content when both hrefs are unsupported', () => {
    const cardHref = 'https://[::1]/card';
    const rowHref = 'javascript:alert(1)';
    const node = render([
      fixture('every-optional.j2')
        .replace('https://example.com/card', cardHref)
        .replace('https://example.com/row', rowHref),
    ]);
    const visible = texts(node);
    expect(visible).toContain('Every optional');
    expect(visible).toContain('Row value');
    expect(visible).toContain(cardHref);
    expect(visible).toContain(rowHref);
    expect(visible).not.toContain('Junction data unavailable');
    expect(flatten(node).filter((entry) => entry.kind === 'button')).toEqual([]);
  });

  it('keeps native workspace order', () => {
    const visible = texts(render([fixture('minimal.j2'), fixture('every-optional.j2')]));
    expect(visible.indexOf('Workspace 0')).toBeLessThan(visible.indexOf('Workspace 1'));
  });
  it('renders labeled HTTPS links and omits absent links', () => {
    const nodes = flatten(render([fixture('every-optional.j2')]));
    const buttons = nodes.filter((n) => n.kind === 'button');
    expect(buttons.map((n) => texts(n))).toEqual([['Every optional'], ['Open link']]);
    expect(buttons.map((n) => n.action)).toEqual([
      { commands: [{ openURL: { _0: 'https://example.com/card' } }] },
      { commands: [{ openURL: { _0: 'https://example.com/row' } }] },
    ]);
    expect(nodes.filter((n) => n.kind === 'vstack' && n.children.length === 0)).toEqual([]);
    expect(nodes.filter((n) => n.kind === 'progressView').map((n) => n.value)).toEqual([2 / 3]);

    const minimalNodes = flatten(render([fixture('minimal.j2')]));
    expect(minimalNodes.filter((n) => n.kind === 'button')).toEqual([]);
    expect(minimalNodes.filter((n) => n.kind === 'vstack' && n.children.length === 0)).toEqual([]);
  });
  for (const code of [
    ...Array.from({ length: 32 }, (_, i) => i),
    ...Array.from({ length: 33 }, (_, i) => i + 127),
  ]) {
    it(`rejects control U+${code.toString(16)}`, () => {
      expect(
        texts(
          render([
            fixture('minimal.j2').replace(
              'Minimal card',
              `before${String.fromCharCode(code)}after`,
            ),
          ]),
        ),
      ).toEqual(['Junction data unavailable']);
    });
  }
});

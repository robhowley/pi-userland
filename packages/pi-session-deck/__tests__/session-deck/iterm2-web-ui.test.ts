import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  SessionDeckDiagnostic,
  SessionDeckRecord,
  SessionDeckSnapshot,
} from '../../extensions/session-deck/types.js';

class FakeNode {
  parentNode: FakeNode | null = null;
  childNodes: FakeNode[] = [];

  append(...children: Array<FakeNode | string>): void {
    for (const child of children) {
      const normalized = typeof child === 'string' ? new FakeTextNode(child) : child;
      normalized.parentNode = this;
      this.childNodes.push(normalized);
    }
  }

  replaceChildren(...children: Array<FakeNode | string>): void {
    this.childNodes = [];
    this.append(...children);
  }

  get textContent(): string {
    return this.childNodes.map((child) => child.textContent).join('');
  }

  set textContent(value: string) {
    this.childNodes = [];
    this.append(new FakeTextNode(value));
  }
}

class FakeTextNode extends FakeNode {
  constructor(private value: string) {
    super();
  }

  override get textContent(): string {
    return this.value;
  }

  override set textContent(value: string) {
    this.value = value;
  }
}

class FakeClassList {
  constructor(private element: FakeElement) {}

  add(...tokens: string[]): void {
    for (const token of tokens) {
      if (token.length > 0) {
        this.element.classes.add(token);
      }
    }
  }

  remove(...tokens: string[]): void {
    for (const token of tokens) {
      this.element.classes.delete(token);
    }
  }

  contains(token: string): boolean {
    return this.element.classes.has(token);
  }

  toggle(token: string, force?: boolean): boolean {
    if (force === true) {
      this.add(token);
      return true;
    }
    if (force === false) {
      this.remove(token);
      return false;
    }
    if (this.contains(token)) {
      this.remove(token);
      return false;
    }
    this.add(token);
    return true;
  }
}

type EventListener = () => void;

class FakeElement extends FakeNode {
  readonly classes = new Set<string>();
  readonly classList = new FakeClassList(this);
  readonly tagName: string;
  readonly attributes = new Map<string, string>();
  readonly listeners = new Map<string, EventListener[]>();
  id = '';
  type = '';

  constructor(tagName: string) {
    super();
    this.tagName = tagName.toUpperCase();
  }

  get className(): string {
    return [...this.classes].join(' ');
  }

  set className(value: string) {
    this.classes.clear();
    for (const token of value.split(/\s+/u)) {
      if (token.length > 0) {
        this.classes.add(token);
      }
    }
  }

  setAttribute(name: string, value: string): void {
    if (name === 'class') {
      this.className = value;
      return;
    }
    if (name === 'id') {
      this.id = value;
      return;
    }
    this.attributes.set(name, value);
  }

  getAttribute(name: string): string | null {
    if (name === 'class') {
      return this.className || null;
    }
    if (name === 'id') {
      return this.id || null;
    }
    return this.attributes.get(name) ?? null;
  }

  addEventListener(type: string, listener: EventListener): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  dispatchEvent(event: { type: string }): boolean {
    for (const listener of this.listeners.get(event.type) ?? []) {
      listener();
    }
    return true;
  }

  click(): void {
    this.dispatchEvent({ type: 'click' });
  }
}

class FakeButtonElement extends FakeElement {
  constructor() {
    super('button');
  }
}

class FakeInputElement extends FakeElement {
  checked = false;

  constructor() {
    super('input');
  }
}

class FakeDocument extends FakeNode {
  createElement(tagName: 'button'): FakeButtonElement;
  createElement(tagName: 'input'): FakeInputElement;
  createElement(tagName: string): FakeElement;
  createElement(tagName: string): FakeElement {
    switch (tagName.toLowerCase()) {
      case 'button':
        return new FakeButtonElement();
      case 'input':
        return new FakeInputElement();
      default:
        return new FakeElement(tagName);
    }
  }

  createTextNode(text: string): FakeTextNode {
    return new FakeTextNode(text);
  }

  getElementById(id: string): FakeElement | null {
    return findById(this, id);
  }
}

interface HarnessElements {
  summary: FakeElement;
  showAll: FakeInputElement;
  refresh: FakeButtonElement;
  banner: FakeElement;
  list: FakeElement;
  empty: FakeElement;
  diagnosticsPanel: FakeElement;
  diagnostics: FakeElement;
}

interface AppHarness {
  elements: HarnessElements;
  pushSnapshot: (snapshot: SessionDeckSnapshot) => void;
}

const HOME = '/Users/tester';
let cleanupGlobals: (() => void) | null = null;

afterEach(() => {
  cleanupGlobals?.();
  cleanupGlobals = null;
  vi.restoreAllMocks();
});

function buildRecord(overrides: Partial<SessionDeckRecord> = {}): SessionDeckRecord {
  return {
    runtimeId: 'rt-1',
    pid: 101,
    presenceState: 'live',
    presenceReason: 'fresh_heartbeat',
    heartbeatAgeMs: 5_000,
    sessionId: 'session-1',
    sessionName: 'alpha',
    repoName: 'project',
    qualifiedRepoName: 'owner/project',
    cwd: `${HOME}/project`,
    branch: 'main',
    prUrl: 'https://github.com/owner/project/pull/42',
    isLinkedWorktree: false,
    worktreeLabel: null,
    activityState: 'idle',
    activityAgeMs: null,
    currentToolName: null,
    lastError: null,
    chips: ['merge-ready clean'],
    diagnostics: [],
    ...overrides,
  };
}

function buildSnapshot(
  options: {
    records?: SessionDeckRecord[];
    diagnostics?: SessionDeckDiagnostic[];
  } = {},
): SessionDeckSnapshot {
  return {
    generatedAt: '2026-07-10T20:15:00.000Z',
    records: options.records ?? [buildRecord()],
    diagnostics: options.diagnostics ?? [],
  };
}

async function setupApp(snapshots: SessionDeckSnapshot[]): Promise<AppHarness> {
  const document = new FakeDocument();
  const elements = buildElements(document);
  const queue = [...snapshots];
  const fetchMock = vi.fn(async () => {
    const snapshot = queue.shift();
    if (!snapshot) {
      throw new Error('Unexpected snapshot fetch.');
    }

    return {
      ok: true,
      status: 200,
      json: async () => snapshot,
    };
  });
  const setIntervalMock = vi.fn(() => 1);

  cleanupGlobals = installBrowserGlobals({ document, fetchMock, setIntervalMock });

  await importFreshApp();
  await flushMicrotasks();

  return {
    elements,
    pushSnapshot: (snapshot) => {
      queue.push(snapshot);
    },
  };
}

function buildElements(document: FakeDocument): HarnessElements {
  const summary = withId(document.createElement('p'), 'summary');
  const showAll = withId(document.createElement('input'), 'show-all');
  showAll.type = 'checkbox';
  const refresh = withId(document.createElement('button'), 'refresh');
  const banner = withId(document.createElement('section'), 'banner');
  banner.className = 'banner hidden';
  const list = withId(document.createElement('div'), 'list');
  const empty = withId(document.createElement('p'), 'empty');
  empty.className = 'empty hidden';
  const diagnosticsPanel = withId(document.createElement('section'), 'diagnostics-panel');
  diagnosticsPanel.className = 'diagnostics-panel hidden';
  const diagnostics = withId(document.createElement('ul'), 'diagnostics');
  diagnosticsPanel.append(diagnostics);

  document.append(summary, showAll, refresh, banner, list, empty, diagnosticsPanel);

  return {
    summary,
    showAll,
    refresh,
    banner,
    list,
    empty,
    diagnosticsPanel,
    diagnostics,
  };
}

function withId<T extends FakeElement>(element: T, id: string): T {
  element.id = id;
  return element;
}

function installBrowserGlobals({
  document,
  fetchMock,
  setIntervalMock,
}: {
  document: FakeDocument;
  fetchMock: ReturnType<typeof vi.fn>;
  setIntervalMock: ReturnType<typeof vi.fn>;
}): () => void {
  const previous = {
    document: Reflect.get(globalThis, 'document'),
    window: Reflect.get(globalThis, 'window'),
    fetch: Reflect.get(globalThis, 'fetch'),
    htmlButtonElement: Reflect.get(globalThis, 'HTMLButtonElement'),
    htmlInputElement: Reflect.get(globalThis, 'HTMLInputElement'),
  };

  Reflect.set(globalThis, 'document', document);
  Reflect.set(globalThis, 'window', { setInterval: setIntervalMock });
  Reflect.set(globalThis, 'fetch', fetchMock);
  Reflect.set(globalThis, 'HTMLButtonElement', FakeButtonElement);
  Reflect.set(globalThis, 'HTMLInputElement', FakeInputElement);

  return () => {
    restoreGlobal('document', previous.document);
    restoreGlobal('window', previous.window);
    restoreGlobal('fetch', previous.fetch);
    restoreGlobal('HTMLButtonElement', previous.htmlButtonElement);
    restoreGlobal('HTMLInputElement', previous.htmlInputElement);
  };
}

function restoreGlobal(name: string, value: unknown): void {
  if (value === undefined) {
    Reflect.deleteProperty(globalThis, name);
    return;
  }
  Reflect.set(globalThis, name, value);
}

async function importFreshApp(): Promise<void> {
  const moduleUrl = new URL('../../extensions/session-deck/iterm2/web/app.js', import.meta.url);
  moduleUrl.searchParams.set('t', `${Date.now()}-${Math.random()}`);
  await import(moduleUrl.href);
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function findById(node: FakeNode, id: string): FakeElement | null {
  for (const child of node.childNodes) {
    if (child instanceof FakeElement && child.id === id) {
      return child;
    }
    const nested = findById(child, id);
    if (nested) {
      return nested;
    }
  }
  return null;
}

function findAllByClass(node: FakeNode, className: string): FakeElement[] {
  const matches: FakeElement[] = [];
  for (const child of node.childNodes) {
    if (child instanceof FakeElement && child.classList.contains(className)) {
      matches.push(child);
    }
    matches.push(...findAllByClass(child, className));
  }
  return matches;
}

function getCards(list: FakeElement): FakeElement[] {
  return list.childNodes.filter((child): child is FakeElement => child instanceof FakeElement);
}

function getExpandedCards(list: FakeElement): FakeElement[] {
  return getCards(list).filter((card) => card.classList.contains('expanded'));
}

function getExpandedCardTitles(list: FakeElement): string[] {
  return getExpandedCards(list)
    .map((card) => findAllByClass(card, 'row-title')[0]?.textContent ?? '')
    .filter((title) => title.length > 0);
}

function getCardToggle(card: FakeElement): FakeButtonElement {
  const toggle = card.childNodes[0];
  if (!(toggle instanceof FakeButtonElement)) {
    throw new Error('Expected card toggle button.');
  }
  return toggle;
}

function getCardLine(card: FakeElement, className: 'row-line1' | 'row-line2'): FakeElement {
  const line = findAllByClass(card, className)[0];
  if (!line) {
    throw new Error(`Expected ${className}.`);
  }
  return line;
}

function getCardDetail(card: FakeElement): FakeElement {
  const detail = findAllByClass(card, 'card-detail')[0];
  if (!detail) {
    throw new Error('Expected card detail.');
  }
  return detail;
}

function getDetailSection(detail: FakeElement, title: string): FakeElement {
  const section = findAllByClass(detail, 'detail-section').find(
    (candidate) => findAllByClass(candidate, 'detail-section-title')[0]?.textContent === title,
  );
  if (!section) {
    throw new Error(`Expected detail section ${title}.`);
  }
  return section;
}

function getDetailSectionTitles(detail: FakeElement): string[] {
  return findAllByClass(detail, 'detail-section-title').map(
    (sectionTitle) => sectionTitle.textContent,
  );
}

function getDetailRowLabels(section: FakeElement): string[] {
  return findAllByClass(section, 'detail-label').map((label) => label.textContent);
}

function getDetailRowValues(section: FakeElement): string[] {
  return findAllByClass(section, 'detail-value').map((value) => value.textContent);
}

function getCopyButtonLabels(root: FakeElement): string[] {
  return findAllByClass(root, 'copy-button')
    .map((button) => button.getAttribute('aria-label'))
    .filter((label): label is string => label !== null);
}

function getCopyButtonTitles(root: FakeElement): string[] {
  return findAllByClass(root, 'copy-button')
    .map((button) => button.getAttribute('title'))
    .filter((title): title is string => title !== null);
}

function getCopyButtonTexts(root: FakeElement): string[] {
  return findAllByClass(root, 'copy-button').map((button) => button.textContent);
}

function getChildTextContents(element: FakeElement): string[] {
  return element.childNodes.map((child) => child.textContent);
}

function setShowAll(elements: HarnessElements, checked: boolean): void {
  elements.showAll.checked = checked;
  elements.showAll.dispatchEvent({ type: 'change' });
}

describe('Session Deck iTerm2 web UI', () => {
  it('renders cards collapsed by default and toggles expansion inline', async () => {
    const harness = await setupApp([
      buildSnapshot({
        records: [
          buildRecord({
            derivedFacets: {
              persistence: 'file_backed',
              interactivity: 'interactive',
              lifecycle: 'resume',
              lineage: 'root',
              identityStrength: 'strong',
              headerConsistency: 'consistent',
            },
          }),
          buildRecord({ runtimeId: 'rt-2', sessionId: 'session-2', sessionName: 'bravo' }),
        ],
      }),
    ]);

    expect(getExpandedCards(harness.elements.list)).toHaveLength(0);
    expect(findAllByClass(getCards(harness.elements.list)[0]!, 'chips-inline')).toHaveLength(1);
    expect(getCardToggle(getCards(harness.elements.list)[0]!).getAttribute('aria-expanded')).toBe(
      'false',
    );
    expect(getCardToggle(getCards(harness.elements.list)[1]!).getAttribute('aria-expanded')).toBe(
      'false',
    );

    getCardToggle(getCards(harness.elements.list)[0]!).click();

    expect(getExpandedCardTitles(harness.elements.list)).toEqual(['alpha']);
    expect(
      findAllByClass(getExpandedCards(harness.elements.list)[0]!, 'chips-inline'),
    ).toHaveLength(0);
    expect(
      getDetailSection(getCardDetail(getExpandedCards(harness.elements.list)[0]!), 'STATUS')
        .textContent,
    ).toContain('merge-ready clean');
    expect(getExpandedCards(harness.elements.list)[0]!.textContent).not.toContain('Derived facets');
    expect(findAllByClass(getExpandedCards(harness.elements.list)[0]!, 'chip-subtle')).toHaveLength(
      0,
    );

    getCardToggle(getCards(harness.elements.list)[1]!).click();

    expect(getExpandedCardTitles(harness.elements.list)).toEqual(['bravo']);
    expect(findAllByClass(getCards(harness.elements.list)[0]!, 'chips-inline')).toHaveLength(1);
    expect(getCardToggle(getCards(harness.elements.list)[1]!).getAttribute('aria-expanded')).toBe(
      'true',
    );

    getCardToggle(getCards(harness.elements.list)[1]!).click();

    expect(getExpandedCards(harness.elements.list)).toHaveLength(0);
    expect(findAllByClass(getCards(harness.elements.list)[1]!, 'chips-inline')).toHaveLength(1);
  });

  it('renders the card age at the end of line 1 and keeps repo, PR, and branch on line 2', async () => {
    const harness = await setupApp([
      buildSnapshot({
        records: [
          buildRecord({
            sessionName: 'gbt baseline',
            repoName: 'shop-ml',
            branch: 'rh-baseline-gbdt',
            prUrl: 'https://github.com/owner/project/pull/22722',
          }),
        ],
      }),
    ]);

    const card = getCards(harness.elements.list)[0]!;
    const line1 = getCardLine(card, 'row-line1');
    const line2 = getCardLine(card, 'row-line2');

    expect(getChildTextContents(line1)).toEqual(['●', 'idle', 'gbt baseline', '5s']);
    expect(findAllByClass(line1, 'row-age')[0]?.textContent).toBe('5s');
    expect(getChildTextContents(line2)).toEqual(['shop-ml', '#22722', 'rh-baseline-gbdt']);
  });

  it('shows tool-running age once by keeping it out of the activity summary', async () => {
    const harness = await setupApp([
      buildSnapshot({
        records: [
          buildRecord({
            activityState: 'tool-running',
            activityAgeMs: 12_000,
            heartbeatAgeMs: 4_000,
            currentToolName: 'bash',
          }),
        ],
      }),
    ]);

    const card = getCards(harness.elements.list)[0]!;
    const line1 = getCardLine(card, 'row-line1');
    const line2 = getCardLine(card, 'row-line2');

    expect(getChildTextContents(line1)).toEqual(['●', 'tool-running: bash', 'alpha', '12s']);
    expect(line1.textContent.match(/12s/gu) ?? []).toHaveLength(1);
    expect(line2.textContent).not.toContain('12s');

    getCardToggle(card).click();

    const detail = getCardDetail(getExpandedCards(harness.elements.list)[0]!);
    const status = getDetailSection(detail, 'STATUS');
    expect(getDetailRowLabels(status)).toEqual(['Current tool']);
    expect(getDetailRowValues(status)).toEqual(['bash']);
  });

  it('starts expanded detail at IDENTITY and keeps workspace copy buttons with PR last', async () => {
    const harness = await setupApp([
      buildSnapshot({
        records: [
          buildRecord({
            sessionName: 'gbdt rankerspec',
            repoName: 'shop-ml',
            qualifiedRepoName: 'Shopify/shop-ml',
            cwd: `${HOME}/src/github.com/Shopify/worktrees/shop-ml-pr22623-rankerspec-uses-pipeline`,
            branch: 'rh-baseline-gbdt-rankerspec-uses-pipeline',
            prUrl: 'https://github.com/owner/project/pull/22623',
            isLinkedWorktree: true,
            worktreeLabel: 'shop-ml-pr22623-rankerspec-uses-pipeline',
            heartbeatAgeMs: 705,
            chips: ['#22623 Conflicts'],
            diagnostics: [{ code: 'activity_stale', message: 'Per-record diagnostic.' }],
          }),
        ],
      }),
    ]);

    getCardToggle(getCards(harness.elements.list)[0]!).click();

    const detail = getCardDetail(getExpandedCards(harness.elements.list)[0]!);
    expect(detail.textContent.startsWith('IDENTITY')).toBe(true);
    expect(findAllByClass(detail, 'detail-title')).toHaveLength(0);
    expect(findAllByClass(detail, 'summary-line')).toHaveLength(0);
    expect(findAllByClass(detail, 'detail-liveness')).toHaveLength(0);
    expect(getDetailSectionTitles(detail)).toEqual([
      'IDENTITY',
      'WORKSPACE',
      'STATUS',
      'Record diagnostics',
    ]);

    const identity = getDetailSection(detail, 'IDENTITY');
    expect(getDetailRowLabels(identity)).toEqual(['Session ID', 'Runtime ID', 'PID']);
    expect(getCopyButtonLabels(identity)).toEqual([
      'Copy Session ID',
      'Copy Runtime ID',
      'Copy PID',
    ]);
    expect(getCopyButtonTitles(identity)).toEqual(['copy', 'copy', 'copy']);
    expect(getCopyButtonTexts(identity)).toEqual(['⧉', '⧉', '⧉']);

    const workspace = getDetailSection(detail, 'WORKSPACE');
    expect(getDetailRowLabels(workspace)).toEqual(['CWD', 'Branch', 'Repo', 'Checkout', 'PR']);
    expect(getDetailRowValues(workspace)).toEqual([
      '~/src/github.com/Shopify/worktrees/shop-ml-pr22623-rankerspec-uses-pipeline',
      'rh-baseline-gbdt-rankerspec-uses-pipeline',
      'Shopify/shop-ml',
      'worktree · shop-ml-pr22623-rankerspec-uses-pipeline',
      '#22623',
    ]);
    expect(getCopyButtonLabels(workspace)).toEqual([
      'Copy CWD',
      'Copy Branch',
      'Copy Repo',
      'Copy Checkout',
      'Copy PR',
    ]);
    expect(getCopyButtonTitles(workspace)).toEqual(['copy', 'copy', 'copy', 'copy', 'copy']);
    expect(getCopyButtonTexts(workspace)).toEqual(['⧉', '⧉', '⧉', '⧉', '⧉']);

    const status = getDetailSection(detail, 'STATUS');
    expect(status.textContent).toContain('#22623 Conflicts');
    expect(getDetailRowLabels(status)).toEqual([]);

    const diagnostics = getDetailSection(detail, 'Record diagnostics');
    expect(diagnostics.textContent).toContain('activity_stale');
    expect(diagnostics.textContent).toContain('Per-record diagnostic.');
  });

  it('keeps non-fresh presence reasons in STATUS without reintroducing the removed summary block', async () => {
    const harness = await setupApp([
      buildSnapshot({
        records: [
          buildRecord({
            presenceState: 'stale',
            presenceReason: 'heartbeat_expired',
            heartbeatAgeMs: 65_000,
          }),
        ],
      }),
    ]);

    getCardToggle(getCards(harness.elements.list)[0]!).click();

    const detail = getCardDetail(getExpandedCards(harness.elements.list)[0]!);
    expect(findAllByClass(detail, 'detail-liveness')).toHaveLength(0);

    const status = getDetailSection(detail, 'STATUS');
    expect(getDetailRowLabels(status)).toEqual(['Presence reason']);
    expect(getDetailRowValues(status)).toEqual(['heartbeat expired']);
  });

  it('keeps cards collapsed across refreshes before the user expands a row', async () => {
    const harness = await setupApp([
      buildSnapshot({
        records: [
          buildRecord(),
          buildRecord({ runtimeId: 'rt-2', sessionId: 'session-2', sessionName: 'bravo' }),
        ],
      }),
    ]);

    harness.pushSnapshot(
      buildSnapshot({
        records: [
          buildRecord({ runtimeId: 'rt-3', sessionId: 'session-3', sessionName: 'charlie' }),
          buildRecord({ runtimeId: 'rt-4', sessionId: 'session-4', sessionName: 'delta' }),
        ],
      }),
    );

    harness.elements.refresh.click();
    await flushMicrotasks();

    expect(getExpandedCards(harness.elements.list)).toHaveLength(0);
    expect(getCardToggle(getCards(harness.elements.list)[0]!).getAttribute('aria-expanded')).toBe(
      'false',
    );
    expect(getCardToggle(getCards(harness.elements.list)[1]!).getAttribute('aria-expanded')).toBe(
      'false',
    );
  });

  it('preserves the expanded runtime by runtimeId across refreshes', async () => {
    const harness = await setupApp([
      buildSnapshot({
        records: [
          buildRecord(),
          buildRecord({ runtimeId: 'rt-2', sessionId: 'session-2', sessionName: 'bravo' }),
        ],
      }),
    ]);

    getCardToggle(getCards(harness.elements.list)[1]!).click();
    harness.pushSnapshot(
      buildSnapshot({
        records: [
          buildRecord({ runtimeId: 'rt-3', sessionId: 'session-3', sessionName: 'charlie' }),
          buildRecord({ runtimeId: 'rt-2', sessionId: 'session-2', sessionName: 'beta' }),
        ],
      }),
    );

    harness.elements.refresh.click();
    await flushMicrotasks();

    expect(getExpandedCardTitles(harness.elements.list)).toEqual(['beta']);
    expect(getExpandedCards(harness.elements.list)[0]!.textContent).toContain('rt-2');
  });

  it('keeps cards collapsed across refreshes after the user hides details', async () => {
    const harness = await setupApp([
      buildSnapshot({
        records: [
          buildRecord(),
          buildRecord({ runtimeId: 'rt-2', sessionId: 'session-2', sessionName: 'bravo' }),
        ],
      }),
    ]);

    getCardToggle(getCards(harness.elements.list)[1]!).click();
    getCardToggle(getCards(harness.elements.list)[1]!).click();
    harness.pushSnapshot(
      buildSnapshot({
        records: [
          buildRecord({ runtimeId: 'rt-3', sessionId: 'session-3', sessionName: 'charlie' }),
          buildRecord({ runtimeId: 'rt-2', sessionId: 'session-2', sessionName: 'beta' }),
        ],
      }),
    );

    harness.elements.refresh.click();
    await flushMicrotasks();

    expect(getCards(harness.elements.list)).toHaveLength(2);
    expect(getExpandedCards(harness.elements.list)).toHaveLength(0);
    expect(getCardToggle(getCards(harness.elements.list)[0]!).getAttribute('aria-expanded')).toBe(
      'false',
    );
    expect(getCardToggle(getCards(harness.elements.list)[1]!).getAttribute('aria-expanded')).toBe(
      'false',
    );
  });

  it('falls back to the first visible record when show-all hides the expanded runtime and keeps snapshot diagnostics in the diagnostics panel', async () => {
    const harness = await setupApp([
      buildSnapshot({
        records: [
          buildRecord(),
          buildRecord({
            runtimeId: 'rt-dead',
            sessionId: 'session-dead',
            sessionName: 'staging',
            presenceState: 'dead',
          }),
        ],
        diagnostics: [{ code: 'read_error', message: 'Presence file is missing for one runtime.' }],
      }),
    ]);

    setShowAll(harness.elements, true);
    expect(harness.elements.diagnosticsPanel.classList.contains('hidden')).toBe(false);
    expect(harness.elements.diagnostics.textContent).toContain('read_error');

    getCardToggle(getCards(harness.elements.list)[1]!).click();
    setShowAll(harness.elements, false);

    expect(getCards(harness.elements.list)).toHaveLength(1);
    expect(getExpandedCardTitles(harness.elements.list)).toEqual(['alpha']);
    expect(harness.elements.diagnosticsPanel.classList.contains('hidden')).toBe(true);
  });

  it('keeps cards collapsed across show-all reconciliation after the user hides details', async () => {
    const harness = await setupApp([
      buildSnapshot({
        records: [
          buildRecord(),
          buildRecord({
            runtimeId: 'rt-dead',
            sessionId: 'session-dead',
            sessionName: 'staging',
            presenceState: 'dead',
          }),
        ],
        diagnostics: [{ code: 'read_error', message: 'Presence file is missing for one runtime.' }],
      }),
    ]);

    setShowAll(harness.elements, true);
    getCardToggle(getCards(harness.elements.list)[1]!).click();
    getCardToggle(getCards(harness.elements.list)[1]!).click();

    setShowAll(harness.elements, false);

    expect(getCards(harness.elements.list)).toHaveLength(1);
    expect(getExpandedCards(harness.elements.list)).toHaveLength(0);
    expect(harness.elements.diagnosticsPanel.classList.contains('hidden')).toBe(true);

    setShowAll(harness.elements, true);

    expect(getCards(harness.elements.list)).toHaveLength(2);
    expect(getExpandedCards(harness.elements.list)).toHaveLength(0);
    expect(harness.elements.diagnosticsPanel.classList.contains('hidden')).toBe(false);
  });

  it('falls back when the expanded runtime disappears and clears selection when the list becomes empty', async () => {
    const harness = await setupApp([
      buildSnapshot({
        records: [
          buildRecord(),
          buildRecord({ runtimeId: 'rt-2', sessionId: 'session-2', sessionName: 'bravo' }),
        ],
      }),
    ]);

    getCardToggle(getCards(harness.elements.list)[1]!).click();
    harness.pushSnapshot(
      buildSnapshot({
        records: [
          buildRecord({ runtimeId: 'rt-3', sessionId: 'session-3', sessionName: 'charlie' }),
        ],
      }),
    );

    harness.elements.refresh.click();
    await flushMicrotasks();

    expect(getExpandedCardTitles(harness.elements.list)).toEqual(['charlie']);

    harness.pushSnapshot(buildSnapshot({ records: [] }));
    harness.elements.refresh.click();
    await flushMicrotasks();

    expect(getCards(harness.elements.list)).toHaveLength(0);
    expect(getExpandedCards(harness.elements.list)).toHaveLength(0);
    expect(harness.elements.empty.classList.contains('hidden')).toBe(false);
    expect(harness.elements.empty.textContent).toBe('No live or stale Pi sessions found.');
  });
});

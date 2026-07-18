import { readFile } from 'node:fs/promises';
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

interface FakeEvent {
  type: string;
  key?: string;
  preventDefault?: () => void;
  stopPropagation?: () => void;
}

type EventListener = (event: FakeEvent) => void;

class FakeElement extends FakeNode {
  readonly classes = new Set<string>();
  readonly classList = new FakeClassList(this);
  readonly tagName: string;
  readonly attributes = new Map<string, string>();
  readonly listeners = new Map<string, EventListener[]>();
  ownerDocument: FakeDocument | null = null;
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

  dispatchEvent(event: FakeEvent): boolean {
    const normalizedEvent = {
      preventDefault() {},
      ...event,
    };
    for (const listener of this.listeners.get(event.type) ?? []) {
      listener(normalizedEvent);
    }
    return true;
  }

  focus(): void {
    this.ownerDocument?.setActiveElement(this);
  }

  click(): void {
    this.dispatchEvent({ type: 'click', preventDefault() {} });
  }
}

class FakeButtonElement extends FakeElement {
  disabled = false;

  constructor() {
    super('button');
  }
}

class FakeInputElement extends FakeElement {
  checked = false;
  value = '';
  selectionStart: number | null = 0;
  selectionEnd: number | null = 0;

  constructor() {
    super('input');
  }

  setSelectionRange(start: number, end: number): void {
    this.selectionStart = start;
    this.selectionEnd = end;
  }
}

class FakeDocument extends FakeNode {
  activeElement: FakeElement | null = null;

  createElement(tagName: 'button'): FakeButtonElement;
  createElement(tagName: 'input'): FakeInputElement;
  createElement(tagName: string): FakeElement;
  createElement(tagName: string): FakeElement {
    const element = (() => {
      switch (tagName.toLowerCase()) {
        case 'button':
          return new FakeButtonElement();
        case 'input':
          return new FakeInputElement();
        default:
          return new FakeElement(tagName);
      }
    })();
    element.ownerDocument = this;
    return element;
  }

  setActiveElement(element: FakeElement): void {
    this.activeElement = element;
  }

  createElementNS(_namespace: string, tagName: string): FakeElement {
    return this.createElement(tagName);
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
  document: FakeDocument;
  elements: HarnessElements;
  pushSnapshot: (snapshot: unknown) => void;
  fetchMock: ReturnType<typeof vi.fn>;
  openMock: ReturnType<typeof vi.fn>;
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
    compaction: null,
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

function buildBasePreview(baseRef = 'origin/main') {
  return {
    ok: true,
    status: 'resolved',
    baseRef,
  };
}

function buildLaunchPreview(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    status: 'resolved',
    mode: 'ambient',
    envAction: 'inherit',
    effectiveDisplay: '~/.pi/agent-or',
    provenance: 'process-env',
    warnings: [],
    ...overrides,
  };
}

function buildJsonResponse(payload: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    json: async () => payload,
  };
}

async function setupApp(snapshots: unknown[]): Promise<AppHarness> {
  const document = new FakeDocument();
  const elements = buildElements(document);
  const queue = [...snapshots];
  const fetchMock = vi.fn(async (url: string, init?: { body?: string }) => {
    if (url === '/actions/create-worktree-preview') {
      const body = JSON.parse(init?.body ?? '{}') as { action?: string };
      if (body.action === 'preview-launch-context') {
        return buildJsonResponse(buildLaunchPreview());
      }
    }

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
  const setTimeoutMock = vi.fn(() => 1);
  const clearTimeoutMock = vi.fn();
  const openMock = vi.fn(() => null);

  cleanupGlobals = installBrowserGlobals({
    document,
    fetchMock,
    setIntervalMock,
    setTimeoutMock,
    clearTimeoutMock,
    openMock,
  });

  await importFreshApp();
  await flushMicrotasks();

  return {
    document,
    elements,
    pushSnapshot: (snapshot) => {
      queue.push(snapshot);
    },
    fetchMock,
    openMock,
  };
}

async function setupAppWithFetch(fetchMock: ReturnType<typeof vi.fn>): Promise<AppHarness> {
  const document = new FakeDocument();
  const elements = buildElements(document);
  const setIntervalMock = vi.fn(() => 1);
  const setTimeoutMock = vi.fn(() => 1);
  const clearTimeoutMock = vi.fn();
  const openMock = vi.fn(() => null);

  cleanupGlobals = installBrowserGlobals({
    document,
    fetchMock,
    setIntervalMock,
    setTimeoutMock,
    clearTimeoutMock,
    openMock,
  });

  await importFreshApp();
  await flushMicrotasks();

  return {
    document,
    elements,
    pushSnapshot: () => {
      throw new Error('setupAppWithFetch does not queue snapshots.');
    },
    fetchMock,
    openMock,
  };
}

async function setupPendingApp(): Promise<{
  elements: HarnessElements;
  resolveSnapshot: (snapshot: unknown) => Promise<void>;
}> {
  const document = new FakeDocument();
  const elements = buildElements(document);
  let resolveResponse:
    | ((response: { ok: boolean; status: number; json: () => Promise<unknown> }) => void)
    | null = null;
  const fetchMock = vi.fn(
    () =>
      new Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>((resolve) => {
        resolveResponse = resolve;
      }),
  );
  const setIntervalMock = vi.fn(() => 1);
  const setTimeoutMock = vi.fn(() => 1);
  const clearTimeoutMock = vi.fn();
  const openMock = vi.fn(() => null);

  cleanupGlobals = installBrowserGlobals({
    document,
    fetchMock,
    setIntervalMock,
    setTimeoutMock,
    clearTimeoutMock,
    openMock,
  });

  await importFreshApp();

  return {
    elements,
    resolveSnapshot: async (snapshot) => {
      if (!resolveResponse) {
        throw new Error('Expected pending snapshot response.');
      }

      resolveResponse({
        ok: true,
        status: 200,
        json: async () => snapshot,
      });
      await flushMicrotasks();
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
  list.setAttribute('role', 'list');
  const empty = withId(document.createElement('p'), 'empty');
  empty.className = 'empty hidden';
  const diagnosticsPanel = withId(document.createElement('section'), 'diagnostics-panel');
  diagnosticsPanel.className = 'diagnostics-panel hidden';
  const diagnostics = withId(document.createElement('ul'), 'diagnostics');
  diagnosticsPanel.append(diagnostics);
  const actionToken = withId(document.createElement('meta'), 'session-deck-action-token');
  actionToken.setAttribute('content', 'test-token');

  document.append(summary, showAll, refresh, banner, list, empty, diagnosticsPanel, actionToken);

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
  setTimeoutMock,
  clearTimeoutMock,
  openMock,
}: {
  document: FakeDocument;
  fetchMock: ReturnType<typeof vi.fn>;
  setIntervalMock: ReturnType<typeof vi.fn>;
  setTimeoutMock: ReturnType<typeof vi.fn>;
  clearTimeoutMock: ReturnType<typeof vi.fn>;
  openMock: ReturnType<typeof vi.fn>;
}): () => void {
  const previous = {
    document: Reflect.get(globalThis, 'document'),
    window: Reflect.get(globalThis, 'window'),
    fetch: Reflect.get(globalThis, 'fetch'),
    htmlButtonElement: Reflect.get(globalThis, 'HTMLButtonElement'),
    htmlInputElement: Reflect.get(globalThis, 'HTMLInputElement'),
  };

  Reflect.set(globalThis, 'document', document);
  Reflect.set(globalThis, 'window', {
    setInterval: setIntervalMock,
    setTimeout: setTimeoutMock,
    clearTimeout: clearTimeoutMock,
    open: openMock,
  });
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

function getRepoGroups(list: FakeElement): FakeElement[] {
  return list.childNodes.filter(
    (child): child is FakeElement =>
      child instanceof FakeElement && child.classList.contains('repo-group'),
  );
}

function getRepoHeaderRow(repoGroup: FakeElement): FakeElement {
  const headerRow = findAllByClass(repoGroup, 'repo-header-row')[0];
  if (!(headerRow instanceof FakeElement)) {
    throw new Error('Expected repo header row.');
  }
  return headerRow;
}

function getRepoHeader(repoGroup: FakeElement): FakeButtonElement {
  const header = findAllByClass(repoGroup, 'repo-header')[0];
  if (!(header instanceof FakeButtonElement)) {
    throw new Error('Expected repo header button.');
  }
  return header;
}

function getRepoActionButton(repoGroup: FakeElement): FakeButtonElement {
  const actionButton = findAllByClass(repoGroup, 'repo-action-button')[0];
  if (!(actionButton instanceof FakeButtonElement)) {
    throw new Error('Expected repo action button.');
  }
  return actionButton;
}

function getRepoHeaders(list: FakeElement): FakeButtonElement[] {
  return getRepoGroups(list).map(getRepoHeader);
}

function getRepoHeaderTexts(list: FakeElement): string[] {
  return getRepoHeaders(list).map((header) => header.textContent);
}

function getRepoGroupByLabel(list: FakeElement, label: string): FakeElement {
  const repoGroup = getRepoGroups(list).find((group) =>
    getRepoHeader(group).textContent.startsWith(`${label} · `),
  );
  if (!repoGroup) {
    throw new Error(`Expected repo group ${label}.`);
  }
  return repoGroup;
}

function getRepoHeaderByLabel(list: FakeElement, label: string): FakeButtonElement {
  return getRepoHeader(getRepoGroupByLabel(list, label));
}

function expandRepoGroup(list: FakeElement, label: string): void {
  const header = getRepoHeaderByLabel(list, label);
  if (header.getAttribute('aria-expanded') !== 'true') {
    header.click();
  }
}

function expandAllRepoGroups(list: FakeElement): void {
  for (const label of getRepoHeaderTexts(list).map((text) => text.split(' · ')[0] ?? text)) {
    expandRepoGroup(list, label);
  }
}

function findAllByTag(node: FakeNode, tagName: string): FakeElement[] {
  const matches: FakeElement[] = [];
  for (const child of node.childNodes) {
    if (child instanceof FakeElement && child.tagName === tagName.toUpperCase()) {
      matches.push(child);
    }
    matches.push(...findAllByTag(child, tagName));
  }
  return matches;
}

function getCards(root: FakeNode): FakeElement[] {
  return findAllByClass(root, 'card');
}

function getPendingWorktreeCards(root: FakeNode): FakeElement[] {
  return findAllByClass(root, 'pending-worktree');
}

function getPendingWorktreeActions(root: FakeNode): FakeButtonElement[] {
  return findAllByClass(root, 'pending-worktree-action').filter(
    (button): button is FakeButtonElement => button instanceof FakeButtonElement,
  );
}

function getPendingWorktreeDismissButtons(root: FakeNode): FakeButtonElement[] {
  return findAllByClass(root, 'pending-worktree-dismiss').filter(
    (button): button is FakeButtonElement => button instanceof FakeButtonElement,
  );
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

function getCardOpenButton(card: FakeElement): FakeButtonElement {
  const openButton = findAllByClass(card, 'card-open')[0];
  if (!(openButton instanceof FakeButtonElement)) {
    throw new Error('Expected card open button.');
  }
  return openButton;
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

function getDetailRow(section: FakeElement, label: string): FakeElement {
  const row = findAllByClass(section, 'detail-row').find(
    (candidate) => findAllByClass(candidate, 'detail-label')[0]?.textContent === label,
  );
  if (!row) {
    throw new Error(`Expected detail row ${label}.`);
  }
  return row;
}

function getDetailRowValue(section: FakeElement, label: string): FakeElement {
  const value = findAllByClass(getDetailRow(section, label), 'detail-value')[0];
  if (!value) {
    throw new Error(`Expected detail value ${label}.`);
  }
  return value;
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

function getChipTexts(root: FakeNode): string[] {
  return findAllByClass(root, 'chip').map((chip) => chip.textContent);
}

function getSummaryCountTexts(root: FakeNode): string[] {
  return findAllByClass(root, 'summary-count').map((count) => count.textContent);
}

function getInlineChipTexts(card: FakeElement): string[] {
  const inlineChips = findAllByClass(card, 'chips-inline')[0];
  return inlineChips ? getChipTexts(inlineChips) : [];
}

function getChildTextContents(element: FakeElement): string[] {
  return element.childNodes.map((child) => child.textContent);
}

function setShowAll(elements: HarnessElements, checked: boolean): void {
  elements.showAll.checked = checked;
  elements.showAll.dispatchEvent({ type: 'change' });
}

describe('Session Deck iTerm2 web UI', () => {
  it('keeps the loading summary fallback until the first snapshot resolves', async () => {
    const harness = await setupPendingApp();

    expect(harness.elements.summary.textContent).toBe('Loading…');
    expect(harness.elements.summary.childNodes).toHaveLength(1);

    await harness.resolveSnapshot(buildSnapshot());

    expect(getSummaryCountTexts(harness.elements.summary)).toEqual(['1 live']);
    expect(harness.elements.summary.childNodes.every((child) => child instanceof FakeElement)).toBe(
      true,
    );
    expect(findAllByClass(harness.elements.summary, 'summary-meta')[0]?.textContent).toContain(
      'updated ',
    );
  });

  it('rejects malformed snapshot objects instead of repairing missing record fields', async () => {
    const harness = await setupApp([
      {
        generatedAt: '2026-07-10T20:15:00.000Z',
        records: [{ runtimeId: 'rt-broken' }],
        diagnostics: [],
      },
    ]);

    expect(getSummaryCountTexts(harness.elements.summary)).toEqual(['0 live']);
    expect(harness.elements.banner.classList.contains('hidden')).toBe(false);
    expect(harness.elements.banner.textContent).toBe(
      'Snapshot payload does not match SessionDeckSnapshot.',
    );
    expect(getCards(harness.elements.list)).toHaveLength(0);
    expect(harness.elements.empty.classList.contains('hidden')).toBe(false);

    setShowAll(harness.elements, true);

    expect(harness.elements.diagnosticsPanel.classList.contains('hidden')).toBe(false);
    expect(harness.elements.diagnostics.textContent).toContain('toolbelt_snapshot_unavailable');
  });

  it('renders repo headers collapsed by default with counts and valid list roles', async () => {
    const harness = await setupApp([
      buildSnapshot({
        records: [
          buildRecord({
            runtimeId: 'rt-alpha-1',
            sessionId: 'session-alpha-1',
            sessionName: 'alpha 1',
            repoName: 'alpha',
            qualifiedRepoName: 'Owner/alpha',
          }),
          buildRecord({
            runtimeId: 'rt-alpha-2',
            sessionId: 'session-alpha-2',
            sessionName: 'alpha 2',
            repoName: 'alpha',
            qualifiedRepoName: 'Owner/alpha',
          }),
          buildRecord({
            runtimeId: 'rt-solo',
            sessionId: 'session-solo',
            sessionName: 'solo',
            repoName: 'solo',
            qualifiedRepoName: 'Owner/solo',
          }),
          buildRecord({
            runtimeId: 'rt-cwd-only',
            sessionId: 'session-cwd-only',
            sessionName: 'cwd only',
            repoName: null,
            qualifiedRepoName: null,
            cwd: `${HOME}/cwd-only`,
          }),
        ],
      }),
    ]);

    expect(harness.elements.list.getAttribute('role')).toBe('list');
    expect(getRepoHeaderTexts(harness.elements.list)).toEqual([
      'Owner/alpha · 2',
      'Owner/solo · 1',
      'No repo · 1',
    ]);

    const alphaHeader = getRepoHeaderByLabel(harness.elements.list, 'Owner/alpha');
    expect(alphaHeader.getAttribute('aria-label')).toBe('Owner/alpha · 2');
    expect(findAllByClass(alphaHeader, 'repo-owner').map((part) => part.textContent)).toEqual([
      'Owner',
      '/',
    ]);
    expect(findAllByClass(alphaHeader, 'repo-name')[0]?.textContent).toBe('alpha');
    expect(findAllByClass(alphaHeader, 'repo-count')[0]?.textContent).toBe('2');

    const noRepoHeader = getRepoHeaderByLabel(harness.elements.list, 'No repo');
    expect(findAllByClass(noRepoHeader, 'repo-owner')).toHaveLength(0);
    expect(findAllByClass(noRepoHeader, 'repo-name')).toHaveLength(0);
    expect(noRepoHeader.textContent).toBe('No repo · 1');
    expect(getRepoHeaders(harness.elements.list).map((header) => header.tagName)).toEqual([
      'BUTTON',
      'BUTTON',
      'BUTTON',
    ]);
    expect(
      getRepoHeaders(harness.elements.list).map((header) => header.getAttribute('aria-expanded')),
    ).toEqual(['false', 'false', 'false']);
    expect(getRepoHeaders(harness.elements.list).map((header) => header.className)).toEqual([
      'repo-header',
      'repo-header',
      'repo-header',
    ]);
    expect(getRepoGroups(harness.elements.list).map((group) => group.getAttribute('role'))).toEqual(
      ['listitem', 'listitem', 'listitem'],
    );
    expect(findAllByClass(harness.elements.list, 'repo-group-records')).toHaveLength(0);
    expect(getCards(harness.elements.list)).toHaveLength(0);
  });

  it('gates visible child runtime labeling on rowKind while keeping proven child detail', async () => {
    const harness = await setupApp([
      buildSnapshot({
        records: [
          buildRecord({
            runtimeId: 'rt-high-child',
            sessionName: 'worker',
            derivedFacets: {
              persistence: 'in_memory',
              rowKind: 'ephemeral_child_runtime',
              interactivity: 'headless',
              lifecycle: 'startup',
              lineage: 'root',
              identityStrength: 'weak',
              headerConsistency: 'consistent',
              childRuntime: {
                candidate: true,
                confidence: 'high',
                parentRuntimeId: 'rt-parent',
                evidence: [
                  {
                    code: 'inherited_deck_runtime',
                    confidence: 'high',
                    parentRuntimeId: 'rt-parent',
                  },
                  {
                    code: 'process_ancestor_match',
                    confidence: 'high',
                    parentRuntimeId: 'rt-parent',
                  },
                ],
              },
            },
          }),
          buildRecord({
            runtimeId: 'rt-env-only',
            sessionId: 'session-low',
            sessionName: 'maybe',
            derivedFacets: {
              persistence: 'in_memory',
              rowKind: 'ephemeral_runtime',
              interactivity: 'interactive',
              lifecycle: 'startup',
              lineage: 'root',
              identityStrength: 'weak',
              headerConsistency: 'consistent',
              childRuntime: {
                candidate: true,
                confidence: 'high',
                parentRuntimeId: 'rt-parent',
                evidence: [
                  {
                    code: 'inherited_deck_runtime',
                    confidence: 'high',
                    parentRuntimeId: 'rt-parent',
                  },
                ],
              },
            },
          }),
        ],
      }),
    ]);

    expandRepoGroup(harness.elements.list, 'owner/project');
    let cards = getCards(harness.elements.list);
    expect(getCardLine(cards[0]!, 'row-line2').textContent).toContain('child: high');
    expect(getCardLine(cards[1]!, 'row-line2').textContent).not.toContain('child: high');

    getCardToggle(cards[0]!).click();
    cards = getCards(harness.elements.list);
    let status = getDetailSection(getCardDetail(cards[0]!), 'STATUS');
    expect(getDetailRowValue(status, 'Child runtime').textContent).toContain(
      'high via deck env + process ancestor · parent rt-paren',
    );

    getCardToggle(cards[1]!).click();
    cards = getCards(harness.elements.list);
    status = getDetailSection(getCardDetail(cards[1]!), 'STATUS');
    expect(getDetailRowLabels(status)).not.toContain('Child runtime');
  });

  it('renders a sibling + New repo-row action and opens the compact composer', async () => {
    const harness = await setupApp([buildSnapshot(), buildBasePreview()]);
    const repoGroup = getRepoGroupByLabel(harness.elements.list, 'owner/project');
    const headerRow = getRepoHeaderRow(repoGroup);
    const header = getRepoHeader(repoGroup);
    const actionButton = getRepoActionButton(repoGroup);

    expect(actionButton.textContent).toBe('+ New');
    expect(actionButton.getAttribute('aria-label')).toBe('create new session');
    expect(actionButton.getAttribute('title')).toBe('create new session');
    expect(actionButton.parentNode).toBe(headerRow);
    expect(findAllByClass(repoGroup, 'repo-actions')).toHaveLength(0);
    expect(findAllByTag(header, 'button')).toHaveLength(0);

    actionButton.click();
    await flushMicrotasks();

    const previewCalls = harness.fetchMock.mock.calls.filter(
      ([url]) => url === '/actions/create-worktree-preview',
    );
    expect(previewCalls).toHaveLength(2);
    expect(
      previewCalls.map(([, init]) => JSON.parse((init as { body?: string }).body ?? '{}').action),
    ).toEqual(['preview-base-ref', 'preview-launch-context']);

    const openedRepoGroup = getRepoGroupByLabel(harness.elements.list, 'owner/project');
    const openedActionButton = getRepoActionButton(openedRepoGroup);
    expect(openedActionButton.textContent).toBe('Cancel');
    expect(openedActionButton.getAttribute('aria-label')).toBe('cancel new session');
    expect(openedActionButton.getAttribute('title')).toBe('cancel new session');
    expect(openedActionButton.parentNode).toBe(getRepoHeaderRow(openedRepoGroup));
    expect(getRepoHeader(openedRepoGroup).getAttribute('aria-expanded')).toBe('false');

    const form = findAllByClass(openedRepoGroup, 'worktree-form')[0];
    expect(form).toBeDefined();
    expect(form!.textContent).toContain('main →');
    expect(form!.textContent).toContain('Pi config → ~/.pi/agent-or');
    expect(form!.textContent).toContain('Change');
    expect(form!.textContent).toContain('Create');
    expect(form!.textContent).not.toContain('Branch name');
    expect(form!.textContent).not.toContain('Cancel');
    expect(form!.textContent).not.toContain('Create session');
    expect(form!.textContent).not.toContain('worktree path generated automatically');
    expect(form!.textContent).not.toContain('Base branch resolves on create');
    expect(form!.textContent).not.toContain('From default branch');
    expect(form!.textContent).not.toContain('From main');
    expect(form!.textContent).not.toContain('tmux');
    expect(form!.textContent).not.toContain('worktree/<');

    const composeRow = findAllByClass(form!, 'worktree-compose-row')[0];
    expect(composeRow).toBeDefined();
    expect(findAllByClass(form!, 'worktree-field-header')).toHaveLength(0);
    expect(findAllByClass(form!, 'worktree-field-label')).toHaveLength(0);
    expect(findAllByClass(form!, 'worktree-field-meta')[0]?.textContent).toBe('main →');

    const branchInput = findAllByTag(form!, 'input').find(
      (input) => input.getAttribute('aria-label') === 'Branch name',
    ) as FakeInputElement | undefined;
    expect(branchInput).toBeDefined();
    expect(branchInput!.getAttribute('placeholder')).toBe('feat/feature-name');
    expect(findAllByTag(form!, 'input').filter((input) => input.type === 'checkbox')).toHaveLength(
      0,
    );
    const branchControl = findAllByClass(form!, 'worktree-branch-control')[0];
    expect(branchControl).toBeDefined();
    const buttons = findAllByTag(form!, 'button') as FakeButtonElement[];
    expect(buttons.map((button) => button.textContent)).toEqual(['Create', 'Change']);
    expect(buttons[1]?.getAttribute('aria-label')).toBe('Change Pi config');
    expect(buttons[1]?.getAttribute('aria-expanded')).toBe('false');
    expect(branchInput!.parentNode).toBe(branchControl);
    expect(buttons[0]?.parentNode).toBe(branchControl);
    expect(buttons[0]?.classList.contains('worktree-submit-button')).toBe(true);
    expect(buttons[0]?.disabled).toBe(false);
  });

  it('ships Prompt Gutter rails and one-row compact composer styling', async () => {
    const css = await readFile(
      new URL('../../extensions/session-deck/iterm2/web/style.css', import.meta.url),
      'utf8',
    );

    expect(css).toContain('--color-bg: #12161e;');
    expect(css).toContain('--color-repo-row: #232936;');
    expect(css).toContain('--color-rail: #8fbcbb;');
    expect(css).toContain("--font-mono: 'SF Mono', 'Berkeley Mono'");
    expect(css).toContain('.topbar-copy::before');
    expect(css).toContain('.repo-header-row::before');
    expect(css).toContain('.repo-group-records::before');
    expect(css).toContain('.repo-group-records > .card::before');
    expect(css).toMatch(
      /\.worktree-form input\[type='text'\]::placeholder\s*\{[\s\S]*color:\s*rgba\(167, 176, 192, 0\.58\);/u,
    );
    expect(css).toMatch(
      /\.worktree-compose-row\s*\{[\s\S]*display:\s*flex;[\s\S]*align-items:\s*center;/u,
    );
    expect(css).toMatch(/\.worktree-branch-control\s*\{[\s\S]*height:\s*32px;/u);
    expect(css).toMatch(
      /\.worktree-form input\[type='text'\]\s*\{[\s\S]*border-radius:\s*7px 0 0 7px;[\s\S]*font-family:\s*var\(--font-mono\)/u,
    );
    expect(css).toMatch(
      /\.worktree-submit-button\s*\{[\s\S]*min-height:\s*32px;[\s\S]*border-radius:\s*0 7px 7px 0;/u,
    );
    expect(css).toContain('.row-activity');
    expect(css).toContain('.worktree-form-feedback');
    expect(css).toContain('.pending-worktree-actions');
    expect(css).not.toContain('.worktree-form-actions');
  });

  it('closes the composer from the header Cancel without posting create-worktree', async () => {
    const harness = await setupApp([buildSnapshot(), buildBasePreview()]);
    const repoGroup = getRepoGroupByLabel(harness.elements.list, 'owner/project');

    getRepoActionButton(repoGroup).click();
    await flushMicrotasks();

    const openedRepoGroup = getRepoGroupByLabel(harness.elements.list, 'owner/project');
    expect(getRepoActionButton(openedRepoGroup).textContent).toBe('Cancel');
    getRepoActionButton(openedRepoGroup).click();
    await flushMicrotasks();

    const rerenderedGroup = getRepoGroupByLabel(harness.elements.list, 'owner/project');
    expect(findAllByClass(rerenderedGroup, 'worktree-form')).toHaveLength(0);
    expect(getRepoActionButton(rerenderedGroup).textContent).toBe('+ New');
    expect(getRepoActionButton(rerenderedGroup).getAttribute('aria-label')).toBe(
      'create new session',
    );
    expect(getRepoHeader(rerenderedGroup).getAttribute('aria-expanded')).toBe('false');
    expect(
      harness.fetchMock.mock.calls.filter(([url]) => url === '/actions/create-worktree'),
    ).toHaveLength(0);
  });

  it('cancels a loading preview without posting create-worktree and ignores the stale preview response', async () => {
    let previewRequestCount = 0;
    let resolveFirstPreview: (() => void) | null = null;
    const fetchMock = vi.fn(async (url: string) => {
      if (url === '/snapshot.json') {
        return buildJsonResponse(buildSnapshot());
      }
      if (url === '/actions/create-worktree-preview') {
        previewRequestCount += 1;
        if (previewRequestCount === 1) {
          return new Promise((resolve) => {
            resolveFirstPreview = () => {
              resolve(buildJsonResponse(buildBasePreview('origin/main')));
            };
          });
        }
        return buildJsonResponse(buildBasePreview('origin/release'));
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const harness = await setupAppWithFetch(fetchMock);
    const repoGroup = getRepoGroupByLabel(harness.elements.list, 'owner/project');

    getRepoActionButton(repoGroup).click();
    const loadingRepoGroup = getRepoGroupByLabel(harness.elements.list, 'owner/project');
    const loadingForm = findAllByClass(loadingRepoGroup, 'worktree-form')[0]!;
    const loadingBranchInput = findAllByTag(loadingForm, 'input').find(
      (input) => input.getAttribute('aria-label') === 'Branch name',
    ) as FakeInputElement;
    loadingBranchInput.value = 'rh/cancel-me';
    loadingBranchInput.dispatchEvent({ type: 'input' });

    getRepoActionButton(loadingRepoGroup).click();
    await flushMicrotasks();

    expect(
      findAllByClass(getRepoGroupByLabel(harness.elements.list, 'owner/project'), 'worktree-form'),
    ).toHaveLength(0);
    expect(
      harness.fetchMock.mock.calls.filter(([url]) => url === '/actions/create-worktree'),
    ).toHaveLength(0);

    const finishFirstPreview = resolveFirstPreview as (() => void) | null;
    if (finishFirstPreview) {
      finishFirstPreview();
    }
    await flushMicrotasks();

    const canceledRepoGroup = getRepoGroupByLabel(harness.elements.list, 'owner/project');
    expect(findAllByClass(canceledRepoGroup, 'worktree-form')).toHaveLength(0);
    expect(getRepoActionButton(canceledRepoGroup).textContent).toBe('+ New');

    getRepoActionButton(canceledRepoGroup).click();
    await flushMicrotasks();

    const reopenedRepoGroup = getRepoGroupByLabel(harness.elements.list, 'owner/project');
    const reopenedForm = findAllByClass(reopenedRepoGroup, 'worktree-form')[0]!;
    const reopenedBranchInput = findAllByTag(reopenedForm, 'input').find(
      (input) => input.getAttribute('aria-label') === 'Branch name',
    ) as FakeInputElement;
    expect(reopenedBranchInput.value).toBe('');
    expect(reopenedForm.textContent).toContain('release →');
  });

  it('keeps the composer independent from the repo disclosure', async () => {
    const harness = await setupApp([buildSnapshot(), buildBasePreview()]);
    const repoGroup = getRepoGroupByLabel(harness.elements.list, 'owner/project');

    getRepoActionButton(repoGroup).click();
    await flushMicrotasks();

    const openedRepoGroup = getRepoGroupByLabel(harness.elements.list, 'owner/project');
    expect(getRepoHeader(openedRepoGroup).getAttribute('aria-expanded')).toBe('false');
    expect(findAllByClass(openedRepoGroup, 'repo-group-records')).toHaveLength(0);
    expect(findAllByClass(openedRepoGroup, 'worktree-form')).toHaveLength(1);
    expect(getRepoActionButton(openedRepoGroup).textContent).toBe('Cancel');

    getRepoHeader(openedRepoGroup).click();

    const expandedRepoGroup = getRepoGroupByLabel(harness.elements.list, 'owner/project');
    expect(getRepoHeader(expandedRepoGroup).getAttribute('aria-expanded')).toBe('true');
    expect(findAllByClass(expandedRepoGroup, 'repo-group-records')).toHaveLength(1);
    expect(findAllByClass(expandedRepoGroup, 'worktree-form')).toHaveLength(1);
    expect(getRepoActionButton(expandedRepoGroup).textContent).toBe('Cancel');

    getRepoHeader(expandedRepoGroup).click();

    const collapsedRepoGroup = getRepoGroupByLabel(harness.elements.list, 'owner/project');
    expect(getRepoHeader(collapsedRepoGroup).getAttribute('aria-expanded')).toBe('false');
    expect(findAllByClass(collapsedRepoGroup, 'repo-group-records')).toHaveLength(0);
    expect(findAllByClass(collapsedRepoGroup, 'worktree-form')).toHaveLength(1);
    expect(getRepoActionButton(collapsedRepoGroup).textContent).toBe('Cancel');

    getRepoActionButton(collapsedRepoGroup).click();
    const closedRepoGroup = getRepoGroupByLabel(harness.elements.list, 'owner/project');
    expect(getRepoHeader(closedRepoGroup).getAttribute('aria-expanded')).toBe('false');
    expect(findAllByClass(closedRepoGroup, 'worktree-form')).toHaveLength(0);
    expect(getRepoActionButton(closedRepoGroup).textContent).toBe('+ New');
  });

  it('disables Create and does not post when the preview is loading', async () => {
    const harness = await setupApp([buildSnapshot(), buildBasePreview()]);
    const repoGroup = getRepoGroupByLabel(harness.elements.list, 'owner/project');

    getRepoActionButton(repoGroup).click();

    const loadingRepoGroup = getRepoGroupByLabel(harness.elements.list, 'owner/project');
    const form = findAllByClass(loadingRepoGroup, 'worktree-form')[0]!;
    expect(findAllByClass(form, 'worktree-field-meta')[0]?.textContent).toBe('Resolving…');
    expect(findAllByClass(form, 'worktree-config-summary')[0]?.textContent).toBe(
      'Pi config resolving…',
    );
    const submitButton = findAllByTag(form, 'button')[0] as FakeButtonElement;
    expect(submitButton.textContent).toBe('Create');
    expect(submitButton.disabled).toBe(true);

    const branchInput = findAllByTag(form, 'input').find(
      (input) => input.getAttribute('aria-label') === 'Branch name',
    ) as FakeInputElement;
    branchInput.value = 'rh/feature-name';
    branchInput.dispatchEvent({ type: 'input' });
    form.dispatchEvent({ type: 'submit' });
    await flushMicrotasks();

    expect(
      harness.fetchMock.mock.calls.filter(([url]) => url === '/actions/create-worktree'),
    ).toHaveLength(0);
  });

  it('shows the safe unresolved repo preview error inline and keeps Create disabled', async () => {
    const harness = await setupApp([
      buildSnapshot(),
      {
        ok: false,
        status: 'failed',
        reason: 'repo-intent-unresolved',
        message: 'Could not resolve the selected repository.',
        recoverable: true,
      },
    ]);
    const repoGroup = getRepoGroupByLabel(harness.elements.list, 'owner/project');

    getRepoActionButton(repoGroup).click();
    await flushMicrotasks();

    const openedRepoGroup = getRepoGroupByLabel(harness.elements.list, 'owner/project');
    const form = findAllByClass(openedRepoGroup, 'worktree-form')[0]!;
    expect(findAllByClass(form, 'worktree-field-meta')[0]?.textContent).toBe('Base unavailable');
    expect(form.textContent).toContain('Could not resolve the selected repository.');
    const submitButton = findAllByTag(form, 'button')[0] as FakeButtonElement;
    expect(submitButton.textContent).toBe('Create');
    expect(submitButton.disabled).toBe(true);

    const branchInput = findAllByTag(form, 'input').find(
      (input) => input.getAttribute('aria-label') === 'Branch name',
    ) as FakeInputElement;
    branchInput.value = 'rh/feature-name';
    branchInput.dispatchEvent({ type: 'input' });
    form.dispatchEvent({ type: 'submit' });
    await flushMicrotasks();

    expect(
      harness.fetchMock.mock.calls.filter(([url]) => url === '/actions/create-worktree'),
    ).toHaveLength(0);
  });

  it('shows the safe ambiguous repo preview error inline and keeps Create disabled', async () => {
    const harness = await setupApp([
      buildSnapshot(),
      {
        ok: false,
        status: 'failed',
        reason: 'repo-intent-ambiguous',
        message: 'The selected repository is ambiguous.',
        recoverable: true,
      },
    ]);
    const repoGroup = getRepoGroupByLabel(harness.elements.list, 'owner/project');

    getRepoActionButton(repoGroup).click();
    await flushMicrotasks();

    const openedRepoGroup = getRepoGroupByLabel(harness.elements.list, 'owner/project');
    const form = findAllByClass(openedRepoGroup, 'worktree-form')[0]!;
    expect(form.textContent).toContain('The selected repository is ambiguous.');
    expect((findAllByTag(form, 'button')[0] as FakeButtonElement).disabled).toBe(true);
  });

  it('closes the composer on Escape without posting create-worktree', async () => {
    const harness = await setupApp([buildSnapshot(), buildBasePreview()]);
    const repoGroup = getRepoGroupByLabel(harness.elements.list, 'owner/project');

    getRepoActionButton(repoGroup).click();
    await flushMicrotasks();

    const openedRepoGroup = getRepoGroupByLabel(harness.elements.list, 'owner/project');
    const form = findAllByClass(openedRepoGroup, 'worktree-form')[0]!;
    form.dispatchEvent({ type: 'keydown', key: 'Escape' });
    await flushMicrotasks();

    const closedRepoGroup = getRepoGroupByLabel(harness.elements.list, 'owner/project');
    expect(findAllByClass(closedRepoGroup, 'worktree-form')).toHaveLength(0);
    expect(getRepoActionButton(closedRepoGroup).textContent).toBe('+ New');
    expect(
      harness.fetchMock.mock.calls.filter(([url]) => url === '/actions/create-worktree'),
    ).toHaveLength(0);
  });

  it('keeps the composer open with the typed branch on invalid branch submit', async () => {
    const harness = await setupApp([
      buildSnapshot(),
      buildBasePreview(),
      {
        ok: false,
        status: 'failed',
        worktree: {
          ok: false,
          reason: 'invalid-branch',
          recoverable: true,
          message: 'Branch name is not valid.',
        },
        launch: { requested: false, mode: 'tmux-detached', status: 'not-started' },
      },
    ]);
    const repoGroup = getRepoGroupByLabel(harness.elements.list, 'owner/project');
    getRepoActionButton(repoGroup).click();
    await flushMicrotasks();

    const form = findAllByClass(
      getRepoGroupByLabel(harness.elements.list, 'owner/project'),
      'worktree-form',
    )[0]!;
    const branchInput = findAllByTag(form, 'input').find(
      (input) => input.getAttribute('aria-label') === 'Branch name',
    ) as FakeInputElement;
    branchInput.value = 'bad branch';
    branchInput.dispatchEvent({ type: 'input' });
    form.dispatchEvent({ type: 'submit' });
    await flushMicrotasks();

    const reopenedForm = findAllByClass(
      getRepoGroupByLabel(harness.elements.list, 'owner/project'),
      'worktree-form',
    )[0]!;
    const reopenedBranchInput = findAllByTag(reopenedForm, 'input').find(
      (input) => input.getAttribute('aria-label') === 'Branch name',
    ) as FakeInputElement;
    expect(reopenedBranchInput.value).toBe('bad branch');
    expect(reopenedForm.textContent).toContain('Branch name is not valid.');
    expect(getPendingWorktreeCards(harness.elements.list)).toHaveLength(0);
  });

  it('keeps the composer open with the typed branch on invalid base submit', async () => {
    const harness = await setupApp([
      buildSnapshot(),
      buildBasePreview(),
      {
        ok: false,
        status: 'failed',
        worktree: {
          ok: false,
          reason: 'invalid-base-ref',
          recoverable: true,
          message: 'Base ref does not resolve to a commit.',
        },
        launch: { requested: false, mode: 'tmux-detached', status: 'not-started' },
      },
    ]);
    const repoGroup = getRepoGroupByLabel(harness.elements.list, 'owner/project');
    getRepoActionButton(repoGroup).click();
    await flushMicrotasks();

    const form = findAllByClass(
      getRepoGroupByLabel(harness.elements.list, 'owner/project'),
      'worktree-form',
    )[0]!;
    const branchInput = findAllByTag(form, 'input').find(
      (input) => input.getAttribute('aria-label') === 'Branch name',
    ) as FakeInputElement;
    branchInput.value = 'rh/feature-name';
    branchInput.dispatchEvent({ type: 'input' });
    form.dispatchEvent({ type: 'submit' });
    await flushMicrotasks();

    const reopenedForm = findAllByClass(
      getRepoGroupByLabel(harness.elements.list, 'owner/project'),
      'worktree-form',
    )[0]!;
    const reopenedBranchInput = findAllByTag(reopenedForm, 'input').find(
      (input) => input.getAttribute('aria-label') === 'Branch name',
    ) as FakeInputElement;
    expect(reopenedBranchInput.value).toBe('rh/feature-name');
    expect(reopenedForm.textContent).toContain('Base ref does not resolve to a commit.');
    expect(getPendingWorktreeCards(harness.elements.list)).toHaveLength(0);
  });

  it('keeps the composer open with the typed branch on unresolved repo submit', async () => {
    const harness = await setupApp([
      buildSnapshot(),
      buildBasePreview(),
      {
        ok: false,
        status: 'failed',
        worktree: {
          ok: false,
          reason: 'repo-intent-unresolved',
          recoverable: true,
          message: 'Could not resolve the selected repository.',
        },
        launch: { requested: false, mode: 'tmux-detached', status: 'not-started' },
      },
    ]);
    const repoGroup = getRepoGroupByLabel(harness.elements.list, 'owner/project');
    getRepoActionButton(repoGroup).click();
    await flushMicrotasks();

    const form = findAllByClass(
      getRepoGroupByLabel(harness.elements.list, 'owner/project'),
      'worktree-form',
    )[0]!;
    const branchInput = findAllByTag(form, 'input').find(
      (input) => input.getAttribute('aria-label') === 'Branch name',
    ) as FakeInputElement;
    branchInput.value = 'rh/feature-name';
    branchInput.dispatchEvent({ type: 'input' });
    form.dispatchEvent({ type: 'submit' });
    await flushMicrotasks();

    const reopenedForm = findAllByClass(
      getRepoGroupByLabel(harness.elements.list, 'owner/project'),
      'worktree-form',
    )[0]!;
    expect(reopenedForm.textContent).toContain('Could not resolve the selected repository.');
    expect(
      (
        findAllByTag(reopenedForm, 'input').find(
          (input) => input.getAttribute('aria-label') === 'Branch name',
        ) as FakeInputElement
      ).value,
    ).toBe('rh/feature-name');
  });

  it('keeps the composer open with the typed branch on ambiguous repo submit', async () => {
    const harness = await setupApp([
      buildSnapshot(),
      buildBasePreview(),
      {
        ok: false,
        status: 'failed',
        worktree: {
          ok: false,
          reason: 'repo-intent-ambiguous',
          recoverable: true,
          message: 'The selected repository is ambiguous.',
        },
        launch: { requested: false, mode: 'tmux-detached', status: 'not-started' },
      },
    ]);
    const repoGroup = getRepoGroupByLabel(harness.elements.list, 'owner/project');
    getRepoActionButton(repoGroup).click();
    await flushMicrotasks();

    const form = findAllByClass(
      getRepoGroupByLabel(harness.elements.list, 'owner/project'),
      'worktree-form',
    )[0]!;
    const branchInput = findAllByTag(form, 'input').find(
      (input) => input.getAttribute('aria-label') === 'Branch name',
    ) as FakeInputElement;
    branchInput.value = 'rh/feature-name';
    branchInput.dispatchEvent({ type: 'input' });
    form.dispatchEvent({ type: 'submit' });
    await flushMicrotasks();

    const reopenedForm = findAllByClass(
      getRepoGroupByLabel(harness.elements.list, 'owner/project'),
      'worktree-form',
    )[0]!;
    expect(reopenedForm.textContent).toContain('The selected repository is ambiguous.');
    expect(
      (
        findAllByTag(reopenedForm, 'input').find(
          (input) => input.getAttribute('aria-label') === 'Branch name',
        ) as FakeInputElement
      ).value,
    ).toBe('rh/feature-name');
  });

  it('submits exact branchName from the New session composer and includes the preview baseRef', async () => {
    const harness = await setupApp([
      buildSnapshot(),
      buildBasePreview(),
      {
        ok: true,
        status: 'created-and-launched',
        worktree: {
          ok: true,
          status: 'created',
          branch: 'rh/feature-name',
          baseRef: 'origin/main',
          repoName: 'project',
          qualifiedRepoName: 'owner/project',
        },
        launch: {
          requested: true,
          ok: true,
          mode: 'tmux-detached',
          status: 'launched',
          message: 'Started a detached tmux Pi session.',
        },
      },
      buildSnapshot(),
    ]);
    const repoGroup = getRepoGroupByLabel(harness.elements.list, 'owner/project');
    getRepoActionButton(repoGroup).click();
    await flushMicrotasks();
    const openedRepoGroup = getRepoGroupByLabel(harness.elements.list, 'owner/project');
    const form = findAllByClass(openedRepoGroup, 'worktree-form')[0]!;
    const branchInput = findAllByTag(form, 'input').find(
      (input) => input.getAttribute('aria-label') === 'Branch name',
    ) as FakeInputElement;

    branchInput.value = 'rh/feature-name';
    branchInput.dispatchEvent({ type: 'input' });
    form.dispatchEvent({ type: 'submit' });
    await flushMicrotasks();

    const actionCall = harness.fetchMock.mock.calls.find(
      ([url]) => url === '/actions/create-worktree',
    );
    expect(actionCall).toBeDefined();
    const requestInit = actionCall![1] as { method?: string; body?: string };
    expect(requestInit.method).toBe('POST');
    expect(JSON.parse(requestInit.body ?? '{}')).toMatchObject({
      repoIntent: {
        repoName: 'project',
        qualifiedRepoName: 'owner/project',
        candidateRuntimeIds: ['rt-1'],
      },
      branchName: 'rh/feature-name',
      baseRef: 'origin/main',
      launch: { mode: 'tmux-detached', agentDir: { mode: 'ambient' } },
    });
    expect(JSON.parse(requestInit.body ?? '{}')).not.toHaveProperty('label');
  });

  it('changes Pi config to custom, validates locally, and preserves the branch draft', async () => {
    const harness = await setupApp([
      buildSnapshot(),
      buildBasePreview(),
      {
        ok: true,
        status: 'created-and-launched',
        worktree: {
          ok: true,
          status: 'created',
          branch: 'rh/custom-agent',
          baseRef: 'origin/main',
          repoName: 'project',
          qualifiedRepoName: 'owner/project',
        },
        launch: {
          requested: true,
          ok: true,
          mode: 'tmux-detached',
          status: 'launched',
          message: 'Started a detached tmux Pi session.',
        },
      },
      buildSnapshot(),
    ]);
    const repoGroup = getRepoGroupByLabel(harness.elements.list, 'owner/project');
    getRepoActionButton(repoGroup).click();
    await flushMicrotasks();

    let form = findAllByClass(
      getRepoGroupByLabel(harness.elements.list, 'owner/project'),
      'worktree-form',
    )[0]!;
    const branchInput = findAllByTag(form, 'input').find(
      (input) => input.getAttribute('aria-label') === 'Branch name',
    ) as FakeInputElement;
    branchInput.value = 'rh/custom-agent';
    branchInput.dispatchEvent({ type: 'input' });
    const changeButton = findAllByTag(form, 'button').find(
      (button) => button.getAttribute('aria-label') === 'Change Pi config',
    ) as FakeButtonElement;
    changeButton.click();

    form = findAllByClass(
      getRepoGroupByLabel(harness.elements.list, 'owner/project'),
      'worktree-form',
    )[0]!;
    expect(findAllByClass(form, 'worktree-config-drawer')).toHaveLength(1);
    const drawerButtonLabels = findAllByTag(form, 'button').map((button) => button.textContent);
    expect(drawerButtonLabels).toContain('Current');
    expect(drawerButtonLabels).toContain('Pi default');
    expect(drawerButtonLabels).not.toContain('Ambient env');
    expect(drawerButtonLabels).not.toContain('Pi default (~/.pi/agent)');
    const customButton = findAllByTag(form, 'button').find(
      (button) => button.textContent === 'Custom…',
    ) as FakeButtonElement;
    customButton.click();

    form = findAllByClass(
      getRepoGroupByLabel(harness.elements.list, 'owner/project'),
      'worktree-form',
    )[0]!;
    const customInput = findAllByTag(form, 'input').find(
      (input) => input.getAttribute('aria-label') === 'Custom Pi config directory',
    ) as FakeInputElement;
    customInput.focus();
    customInput.value = 'relative';
    customInput.dispatchEvent({ type: 'input' });

    form = findAllByClass(
      getRepoGroupByLabel(harness.elements.list, 'owner/project'),
      'worktree-form',
    )[0]!;
    const focusedInvalidCustomInput = findAllByTag(form, 'input').find(
      (input) => input.getAttribute('aria-label') === 'Custom Pi config directory',
    );
    expect(harness.document.activeElement).toBe(focusedInvalidCustomInput);
    await flushMicrotasks();
    form = findAllByClass(
      getRepoGroupByLabel(harness.elements.list, 'owner/project'),
      'worktree-form',
    )[0]!;
    const focusedInvalidCustomInputAfterPreview = findAllByTag(form, 'input').find(
      (input) => input.getAttribute('aria-label') === 'Custom Pi config directory',
    );
    expect(harness.document.activeElement).toBe(focusedInvalidCustomInputAfterPreview);
    expect(form.textContent).toContain('Custom Pi config must be absolute or start with ~/.');
    expect((findAllByTag(form, 'button')[0] as FakeButtonElement).disabled).toBe(true);
    expect(
      (
        findAllByTag(form, 'input').find(
          (input) => input.getAttribute('aria-label') === 'Branch name',
        ) as FakeInputElement
      ).value,
    ).toBe('rh/custom-agent');

    const fixedCustomInput = findAllByTag(form, 'input').find(
      (input) => input.getAttribute('aria-label') === 'Custom Pi config directory',
    ) as FakeInputElement;
    fixedCustomInput.value = '~/agent-work';
    fixedCustomInput.dispatchEvent({ type: 'input' });
    form = findAllByClass(
      getRepoGroupByLabel(harness.elements.list, 'owner/project'),
      'worktree-form',
    )[0]!;
    const focusedValidCustomInput = findAllByTag(form, 'input').find(
      (input) => input.getAttribute('aria-label') === 'Custom Pi config directory',
    );
    expect(harness.document.activeElement).toBe(focusedValidCustomInput);
    form.dispatchEvent({ type: 'submit' });
    await flushMicrotasks();

    const actionCall = harness.fetchMock.mock.calls.find(
      ([url]) => url === '/actions/create-worktree',
    );
    expect(actionCall).toBeDefined();
    expect(JSON.parse((actionCall?.[1] as { body?: string })?.body ?? '{}')).toMatchObject({
      branchName: 'rh/custom-agent',
      launch: {
        mode: 'tmux-detached',
        agentDir: { mode: 'custom', customDir: '~/agent-work' },
      },
    });
  });

  it('renders a no-worktree-created preflight failure with doctor guidance', async () => {
    const harness = await setupApp([
      buildSnapshot(),
      buildBasePreview(),
      {
        ok: false,
        status: 'preflight-failed',
        failurePhase: 'preflight',
        preflight: {
          requested: true,
          ok: false,
          mode: 'tmux-detached',
          status: 'failed',
          reason: 'tmux-unavailable',
          recoverable: true,
          message: 'New Pi session requires tmux on PATH; no worktree was created.',
        },
        worktree: { requested: false, status: 'not-started' },
        launch: { requested: false, mode: 'tmux-detached', status: 'not-started' },
      },
    ]);
    const repoGroup = getRepoGroupByLabel(harness.elements.list, 'owner/project');
    getRepoActionButton(repoGroup).click();
    await flushMicrotasks();

    const form = findAllByClass(
      getRepoGroupByLabel(harness.elements.list, 'owner/project'),
      'worktree-form',
    )[0]!;
    const branchInput = findAllByTag(form, 'input').find(
      (input) => input.getAttribute('aria-label') === 'Branch name',
    ) as FakeInputElement;
    branchInput.value = 'rh/feature-name';
    branchInput.dispatchEvent({ type: 'input' });
    form.dispatchEvent({ type: 'submit' });
    await flushMicrotasks();

    expect(harness.elements.list.textContent).toContain('no worktree was created');
    expect(harness.elements.list.textContent).toContain('/session-deck iterm2 doctor');
    expect(harness.elements.list.textContent).not.toContain('Diagnostics');
    expect(getPendingWorktreeActions(harness.elements.list)).toHaveLength(0);
    expect(getPendingWorktreeDismissButtons(harness.elements.list)).toHaveLength(0);
    expect(getPendingWorktreeCards(harness.elements.list)).toHaveLength(0);
    const reopenedForm = findAllByClass(
      getRepoGroupByLabel(harness.elements.list, 'owner/project'),
      'worktree-form',
    )[0]!;
    expect(reopenedForm.textContent).toContain('no worktree was created');
    expect(
      (
        findAllByTag(reopenedForm, 'input').find(
          (input) => input.getAttribute('aria-label') === 'Branch name',
        ) as FakeInputElement
      ).value,
    ).toBe('rh/feature-name');
  });

  it('renders the pi preflight failure with no-worktree-created guidance', async () => {
    const harness = await setupApp([
      buildSnapshot(),
      buildBasePreview(),
      {
        ok: false,
        status: 'preflight-failed',
        failurePhase: 'preflight',
        preflight: {
          requested: true,
          ok: false,
          mode: 'tmux-detached',
          status: 'failed',
          reason: 'pi-command-unavailable',
          recoverable: true,
          message: 'New Pi session requires the pi executable on PATH; no worktree was created.',
        },
        worktree: { requested: false, status: 'not-started' },
        launch: { requested: false, mode: 'tmux-detached', status: 'not-started' },
      },
    ]);
    const repoGroup = getRepoGroupByLabel(harness.elements.list, 'owner/project');
    getRepoActionButton(repoGroup).click();
    await flushMicrotasks();

    const form = findAllByClass(
      getRepoGroupByLabel(harness.elements.list, 'owner/project'),
      'worktree-form',
    )[0]!;
    const branchInput = findAllByTag(form, 'input').find(
      (input) => input.getAttribute('aria-label') === 'Branch name',
    ) as FakeInputElement;
    branchInput.value = 'rh/feature-name';
    branchInput.dispatchEvent({ type: 'input' });
    form.dispatchEvent({ type: 'submit' });
    await flushMicrotasks();

    expect(harness.elements.list.textContent).toContain('no worktree was created');
    expect(harness.elements.list.textContent).toContain('install Pi');
    expect(harness.elements.list.textContent).not.toContain('Diagnostics');
    expect(getPendingWorktreeActions(harness.elements.list)).toHaveLength(0);
  });

  it('renders launch success without runtimeId and clears the card after a matching refresh', async () => {
    const harness = await setupApp([
      buildSnapshot(),
      buildBasePreview(),
      {
        ok: true,
        status: 'created-and-launched',
        worktree: {
          ok: true,
          status: 'created',
          branch: 'rh/feature-name',
          baseRef: 'origin/main',
          repoName: 'project',
          qualifiedRepoName: 'owner/project',
        },
        launch: {
          requested: true,
          ok: true,
          mode: 'tmux-detached',
          status: 'launched',
          message: 'Started a detached tmux Pi session.',
        },
      },
      buildSnapshot(),
    ]);
    const repoGroup = getRepoGroupByLabel(harness.elements.list, 'owner/project');
    getRepoActionButton(repoGroup).click();
    await flushMicrotasks();

    const form = findAllByClass(
      getRepoGroupByLabel(harness.elements.list, 'owner/project'),
      'worktree-form',
    )[0]!;
    const branchInput = findAllByTag(form, 'input').find(
      (input) => input.getAttribute('aria-label') === 'Branch name',
    ) as FakeInputElement;
    branchInput.value = 'rh/feature-name';
    branchInput.dispatchEvent({ type: 'input' });
    form.dispatchEvent({ type: 'submit' });
    await flushMicrotasks();

    expect(harness.elements.list.textContent).toContain('Session launched');
    expect(harness.elements.list.textContent).toContain(
      'Pi session launched. Session Deck will pick it up automatically.',
    );
    expect(harness.elements.list.textContent).not.toContain('Waiting for session to appear');
    expect(getPendingWorktreeCards(harness.elements.list)).toHaveLength(1);

    harness.pushSnapshot(
      buildSnapshot({
        records: [
          buildRecord(),
          buildRecord({
            runtimeId: 'rt-created',
            sessionId: 'session-created',
            sessionName: 'feature',
            branch: 'rh/feature-name',
            isLinkedWorktree: true,
            worktreeLabel: 'feature-name',
          }),
        ],
      }),
    );
    harness.elements.refresh.click();
    await flushMicrotasks();

    expect(getPendingWorktreeCards(harness.elements.list)).toHaveLength(0);
    expect(harness.elements.list.textContent).toContain('feature');
  });

  it('renders partial launch failure with retry only, and retry re-posts the original request', async () => {
    const harness = await setupApp([
      buildSnapshot(),
      buildBasePreview(),
      {
        ok: false,
        status: 'partial-launch-failed',
        failurePhase: 'launch',
        worktreeRetained: true,
        worktree: {
          ok: true,
          status: 'created',
          branch: 'rh/feature-name',
          baseRef: 'origin/main',
          repoName: 'project',
          qualifiedRepoName: 'owner/project',
        },
        launch: {
          requested: true,
          ok: false,
          mode: 'tmux-detached',
          status: 'failed',
          reason: 'spawn-failed',
          recoverable: true,
          message: 'Created worktree, but tmux could not start Pi.',
        },
      },
      buildSnapshot(),
      {
        ok: true,
        status: 'reused-and-launched',
        worktree: {
          ok: true,
          status: 'reused',
          branch: 'rh/feature-name',
          baseRef: 'origin/main',
          repoName: 'project',
          qualifiedRepoName: 'owner/project',
        },
        launch: {
          requested: true,
          ok: true,
          mode: 'tmux-detached',
          status: 'reused-existing',
          message: 'Reused an existing detached tmux Pi session.',
        },
      },
      buildSnapshot(),
    ]);
    const repoGroup = getRepoGroupByLabel(harness.elements.list, 'owner/project');
    getRepoActionButton(repoGroup).click();
    await flushMicrotasks();

    const form = findAllByClass(
      getRepoGroupByLabel(harness.elements.list, 'owner/project'),
      'worktree-form',
    )[0]!;
    const branchInput = findAllByTag(form, 'input').find(
      (input) => input.getAttribute('aria-label') === 'Branch name',
    ) as FakeInputElement;
    branchInput.value = 'rh/feature-name';
    branchInput.dispatchEvent({ type: 'input' });
    form.dispatchEvent({ type: 'submit' });
    await flushMicrotasks();

    expect(harness.elements.list.textContent).toContain('Worktree ready · Pi did not start');
    expect(harness.elements.list.textContent).toContain('Worktree kept. Pi did not start.');
    const actions = getPendingWorktreeActions(harness.elements.list);
    expect(actions.map((button) => button.textContent)).toEqual(['Retry']);
    expect(harness.elements.list.textContent).not.toContain('Cleanup');
    expect(harness.elements.list.textContent).not.toContain('Diagnostics');

    const firstRequest = JSON.parse(
      (
        harness.fetchMock.mock.calls.find(([url]) => url === '/actions/create-worktree')?.[1] as {
          body?: string;
        }
      )?.body ?? '{}',
    );

    actions[0]?.click();
    await flushMicrotasks();

    const createCalls = harness.fetchMock.mock.calls.filter(
      ([url]) => url === '/actions/create-worktree',
    );
    expect(createCalls).toHaveLength(2);
    expect(JSON.parse((createCalls[1]?.[1] as { body?: string })?.body ?? '{}')).toEqual(
      firstRequest,
    );
    expect(harness.elements.list.textContent).toContain('Session reused');
  });

  it('sorts named repo groups case-insensitively and keeps No repo last', async () => {
    const harness = await setupApp([
      buildSnapshot({
        records: [
          buildRecord({
            runtimeId: 'rt-zeta',
            sessionId: 'session-zeta',
            sessionName: 'zeta',
            repoName: 'repo-zeta',
            qualifiedRepoName: 'zeta/repo',
          }),
          buildRecord({
            runtimeId: 'rt-alpha',
            sessionId: 'session-alpha',
            sessionName: 'alpha',
            repoName: 'repo-alpha',
            qualifiedRepoName: 'Alpha/repo',
          }),
          buildRecord({
            runtimeId: 'rt-middle',
            sessionId: 'session-middle',
            sessionName: 'middle',
            repoName: 'middle',
            qualifiedRepoName: null,
          }),
          buildRecord({
            runtimeId: 'rt-no-repo',
            sessionId: 'session-no-repo',
            sessionName: 'no repo',
            repoName: null,
            qualifiedRepoName: null,
          }),
        ],
      }),
    ]);

    expect(getRepoHeaderTexts(harness.elements.list)).toEqual([
      'Alpha/repo · 1',
      'middle · 1',
      'zeta/repo · 1',
      'No repo · 1',
    ]);
  });

  it('groups by repo identity and only merges unqualified records into one matching short name', async () => {
    const harness = await setupApp([
      buildSnapshot({
        records: [
          buildRecord({
            runtimeId: 'rt-shared-legacy',
            sessionId: 'session-shared-legacy',
            sessionName: 'legacy shared',
            repoName: 'shared',
            qualifiedRepoName: null,
          }),
          buildRecord({
            runtimeId: 'rt-shared-qualified',
            sessionId: 'session-shared-qualified',
            sessionName: 'qualified shared',
            repoName: 'shared',
            qualifiedRepoName: 'owner/shared',
          }),
          buildRecord({
            runtimeId: 'rt-ambiguous-a',
            sessionId: 'session-ambiguous-a',
            sessionName: 'qualified ambiguous a',
            repoName: 'ambiguous',
            qualifiedRepoName: 'owner-a/ambiguous',
          }),
          buildRecord({
            runtimeId: 'rt-ambiguous-b',
            sessionId: 'session-ambiguous-b',
            sessionName: 'qualified ambiguous b',
            repoName: 'ambiguous',
            qualifiedRepoName: 'owner-b/ambiguous',
          }),
          buildRecord({
            runtimeId: 'rt-ambiguous-legacy',
            sessionId: 'session-ambiguous-legacy',
            sessionName: 'legacy ambiguous',
            repoName: 'ambiguous',
            qualifiedRepoName: null,
          }),
        ],
      }),
    ]);

    expect(getRepoHeaderTexts(harness.elements.list)).toEqual([
      'ambiguous · 1',
      'owner-a/ambiguous · 1',
      'owner-b/ambiguous · 1',
      'owner/shared · 2',
    ]);

    expandRepoGroup(harness.elements.list, 'owner/shared');
    expect(
      findAllByClass(getRepoGroupByLabel(harness.elements.list, 'owner/shared'), 'row-title').map(
        (title) => title.textContent,
      ),
    ).toEqual(['legacy shared', 'qualified shared']);

    expandRepoGroup(harness.elements.list, 'ambiguous');
    expect(
      findAllByClass(getRepoGroupByLabel(harness.elements.list, 'ambiguous'), 'row-title').map(
        (title) => title.textContent,
      ),
    ).toEqual(['legacy ambiguous']);
  });

  it('expands repo disclosures independently with nested session lists', async () => {
    const harness = await setupApp([
      buildSnapshot({
        records: [
          buildRecord({
            runtimeId: 'rt-a',
            sessionId: 'session-a',
            sessionName: 'alpha',
            repoName: 'alpha',
            qualifiedRepoName: 'owner/alpha',
          }),
          buildRecord({
            runtimeId: 'rt-b',
            sessionId: 'session-b',
            sessionName: 'bravo',
            repoName: 'bravo',
            qualifiedRepoName: 'owner/bravo',
          }),
        ],
      }),
    ]);

    expect(getCards(harness.elements.list)).toHaveLength(0);

    expandRepoGroup(harness.elements.list, 'owner/alpha');

    expect(
      getRepoHeaderByLabel(harness.elements.list, 'owner/alpha').getAttribute('aria-expanded'),
    ).toBe('true');
    expect(
      getRepoHeaderByLabel(harness.elements.list, 'owner/bravo').getAttribute('aria-expanded'),
    ).toBe('false');
    expect(getCards(getRepoGroupByLabel(harness.elements.list, 'owner/alpha'))).toHaveLength(1);
    expect(getCards(getRepoGroupByLabel(harness.elements.list, 'owner/bravo'))).toHaveLength(0);
    const alphaRecords = findAllByClass(
      getRepoGroupByLabel(harness.elements.list, 'owner/alpha'),
      'repo-group-records',
    )[0]!;
    expect(alphaRecords.getAttribute('role')).toBe('list');
    expect(
      getRepoHeaderByLabel(harness.elements.list, 'owner/alpha').getAttribute('aria-controls'),
    ).toBe(alphaRecords.getAttribute('id'));

    expandRepoGroup(harness.elements.list, 'owner/bravo');

    expect(getCards(harness.elements.list)).toHaveLength(2);
    expect(
      getRepoHeaderByLabel(harness.elements.list, 'owner/alpha').getAttribute('aria-expanded'),
    ).toBe('true');
    expect(
      getRepoHeaderByLabel(harness.elements.list, 'owner/bravo').getAttribute('aria-expanded'),
    ).toBe('true');

    getRepoHeaderByLabel(harness.elements.list, 'owner/alpha').click();

    expect(
      getRepoHeaderByLabel(harness.elements.list, 'owner/alpha').getAttribute('aria-expanded'),
    ).toBe('false');
    expect(
      getRepoHeaderByLabel(harness.elements.list, 'owner/bravo').getAttribute('aria-expanded'),
    ).toBe('true');
    expect(getCards(harness.elements.list)).toHaveLength(1);
    expect(getCardLine(getCards(harness.elements.list)[0]!, 'row-line1').textContent).toContain(
      'bravo',
    );
  });

  it('keeps repo disclosure aria-controls ids stable by repo key across reorder', async () => {
    const harness = await setupApp([
      buildSnapshot({
        records: [
          buildRecord({
            runtimeId: 'rt-bravo',
            sessionId: 'session-bravo',
            sessionName: 'bravo',
            repoName: 'bravo',
            qualifiedRepoName: 'owner/bravo',
          }),
        ],
      }),
    ]);

    expandRepoGroup(harness.elements.list, 'owner/bravo');
    const initialBravoRecords = findAllByClass(
      getRepoGroupByLabel(harness.elements.list, 'owner/bravo'),
      'repo-group-records',
    )[0]!;
    const initialBravoId = getRepoHeaderByLabel(harness.elements.list, 'owner/bravo').getAttribute(
      'aria-controls',
    );
    expect(initialBravoId).toBe(initialBravoRecords.getAttribute('id'));

    harness.pushSnapshot(
      buildSnapshot({
        records: [
          buildRecord({
            runtimeId: 'rt-alpha',
            sessionId: 'session-alpha',
            sessionName: 'alpha',
            repoName: 'alpha',
            qualifiedRepoName: 'owner/alpha',
          }),
          buildRecord({
            runtimeId: 'rt-bravo',
            sessionId: 'session-bravo',
            sessionName: 'bravo refreshed',
            repoName: 'bravo',
            qualifiedRepoName: 'owner/bravo',
          }),
        ],
      }),
    );

    harness.elements.refresh.click();
    await flushMicrotasks();

    const refreshedBravoRecords = findAllByClass(
      getRepoGroupByLabel(harness.elements.list, 'owner/bravo'),
      'repo-group-records',
    )[0]!;
    const refreshedBravoId = getRepoHeaderByLabel(
      harness.elements.list,
      'owner/bravo',
    ).getAttribute('aria-controls');
    expect(refreshedBravoId).toBe(initialBravoId);
    expect(refreshedBravoId).toBe(refreshedBravoRecords.getAttribute('id'));

    expandRepoGroup(harness.elements.list, 'owner/alpha');
    const alphaRecords = findAllByClass(
      getRepoGroupByLabel(harness.elements.list, 'owner/alpha'),
      'repo-group-records',
    )[0]!;
    const alphaId = getRepoHeaderByLabel(harness.elements.list, 'owner/alpha').getAttribute(
      'aria-controls',
    );
    expect(alphaId).toBe(alphaRecords.getAttribute('id'));
    expect(alphaId).not.toBe(refreshedBravoId);
  });

  it('counts only currently visible records and keeps newly visible repos collapsed', async () => {
    const harness = await setupApp([
      buildSnapshot({
        records: [
          buildRecord({
            runtimeId: 'rt-live',
            sessionId: 'session-live',
            sessionName: 'live',
            repoName: 'live',
            qualifiedRepoName: 'owner/live',
          }),
          buildRecord({
            runtimeId: 'rt-dead',
            sessionId: 'session-dead',
            sessionName: 'dead',
            repoName: 'dead',
            qualifiedRepoName: 'owner/dead',
            presenceState: 'dead',
          }),
        ],
      }),
    ]);

    expect(getRepoHeaderTexts(harness.elements.list)).toEqual(['owner/live · 1']);
    expandRepoGroup(harness.elements.list, 'owner/live');

    setShowAll(harness.elements, true);

    expect(getRepoHeaderTexts(harness.elements.list)).toEqual(['owner/dead · 1', 'owner/live · 1']);
    expect(
      getRepoHeaderByLabel(harness.elements.list, 'owner/live').getAttribute('aria-expanded'),
    ).toBe('true');
    expect(
      getRepoHeaderByLabel(harness.elements.list, 'owner/dead').getAttribute('aria-expanded'),
    ).toBe('false');
    expect(getCards(harness.elements.list)).toHaveLength(1);

    setShowAll(harness.elements, false);

    expect(getRepoHeaderTexts(harness.elements.list)).toEqual(['owner/live · 1']);
    expect(
      getRepoHeaderByLabel(harness.elements.list, 'owner/live').getAttribute('aria-expanded'),
    ).toBe('true');
  });

  it('preserves and prunes expanded repo keys across refreshes', async () => {
    const harness = await setupApp([
      buildSnapshot({
        records: [
          buildRecord({
            runtimeId: 'rt-keep',
            sessionId: 'session-keep',
            sessionName: 'keep',
            repoName: 'keep',
            qualifiedRepoName: 'owner/keep',
          }),
          buildRecord({
            runtimeId: 'rt-drop',
            sessionId: 'session-drop',
            sessionName: 'drop',
            repoName: 'drop',
            qualifiedRepoName: 'owner/drop',
          }),
        ],
      }),
    ]);

    expandRepoGroup(harness.elements.list, 'owner/keep');
    expandRepoGroup(harness.elements.list, 'owner/drop');
    harness.pushSnapshot(
      buildSnapshot({
        records: [
          buildRecord({
            runtimeId: 'rt-keep',
            sessionId: 'session-keep',
            sessionName: 'keep refreshed',
            repoName: 'keep',
            qualifiedRepoName: 'owner/keep',
          }),
          buildRecord({
            runtimeId: 'rt-new',
            sessionId: 'session-new',
            sessionName: 'new',
            repoName: 'new',
            qualifiedRepoName: 'owner/new',
          }),
        ],
      }),
    );

    harness.elements.refresh.click();
    await flushMicrotasks();

    expect(getRepoHeaderTexts(harness.elements.list)).toEqual(['owner/keep · 1', 'owner/new · 1']);
    expect(
      getRepoHeaderByLabel(harness.elements.list, 'owner/keep').getAttribute('aria-expanded'),
    ).toBe('true');
    expect(
      getRepoHeaderByLabel(harness.elements.list, 'owner/new').getAttribute('aria-expanded'),
    ).toBe('false');

    harness.pushSnapshot(
      buildSnapshot({
        records: [
          buildRecord({
            runtimeId: 'rt-keep',
            sessionId: 'session-keep',
            sessionName: 'keep refreshed again',
            repoName: 'keep',
            qualifiedRepoName: 'owner/keep',
          }),
          buildRecord({
            runtimeId: 'rt-drop',
            sessionId: 'session-drop',
            sessionName: 'drop returns',
            repoName: 'drop',
            qualifiedRepoName: 'owner/drop',
          }),
          buildRecord({
            runtimeId: 'rt-new',
            sessionId: 'session-new',
            sessionName: 'new',
            repoName: 'new',
            qualifiedRepoName: 'owner/new',
          }),
        ],
      }),
    );

    harness.elements.refresh.click();
    await flushMicrotasks();

    expect(
      getRepoHeaderByLabel(harness.elements.list, 'owner/keep').getAttribute('aria-expanded'),
    ).toBe('true');
    expect(
      getRepoHeaderByLabel(harness.elements.list, 'owner/drop').getAttribute('aria-expanded'),
    ).toBe('false');
    expect(
      getRepoHeaderByLabel(harness.elements.list, 'owner/new').getAttribute('aria-expanded'),
    ).toBe('false');
  });

  it('restores the selected card detail when a collapsed parent repo is reopened', async () => {
    const harness = await setupApp([
      buildSnapshot({
        records: [
          buildRecord(),
          buildRecord({ runtimeId: 'rt-2', sessionId: 'session-2', sessionName: 'bravo' }),
        ],
      }),
    ]);

    expandRepoGroup(harness.elements.list, 'owner/project');
    getCardToggle(getCards(harness.elements.list)[1]!).click();

    expect(getExpandedCardTitles(harness.elements.list)).toEqual(['bravo']);

    getRepoHeaderByLabel(harness.elements.list, 'owner/project').click();

    expect(
      getRepoHeaderByLabel(harness.elements.list, 'owner/project').getAttribute('aria-expanded'),
    ).toBe('false');
    expect(getCards(harness.elements.list)).toHaveLength(0);
    expect(getExpandedCards(harness.elements.list)).toHaveLength(0);

    expandRepoGroup(harness.elements.list, 'owner/project');

    expect(getExpandedCardTitles(harness.elements.list)).toEqual(['bravo']);
    expect(getExpandedCards(harness.elements.list)[0]!.textContent).toContain('rt-2');
  });

  it('hides zero summary states in all mode', async () => {
    const harness = await setupApp([buildSnapshot()]);
    expandAllRepoGroups(harness.elements.list);

    expect(getSummaryCountTexts(harness.elements.summary)).toEqual(['1 live']);

    setShowAll(harness.elements, true);

    expect(getSummaryCountTexts(harness.elements.summary)).toEqual(['1 live']);
    expect(getCards(harness.elements.list)).toHaveLength(1);
  });

  it('renders summary counts from DOM nodes and keeps updated meta visible', async () => {
    const harness = await setupApp([
      buildSnapshot({
        records: [
          buildRecord(),
          buildRecord({
            runtimeId: 'rt-stale',
            sessionId: 'session-stale',
            sessionName: 'stale-session',
            presenceState: 'stale',
            presenceReason: 'heartbeat_expired',
            heartbeatAgeMs: 65_000,
          }),
          buildRecord({
            runtimeId: 'rt-dead',
            sessionId: 'session-dead',
            sessionName: 'dead-session',
            presenceState: 'dead',
            presenceReason: 'process_exited',
          }),
          buildRecord({
            runtimeId: 'rt-unknown',
            sessionId: 'session-unknown',
            sessionName: 'unknown-session',
            presenceState: 'unknown',
            presenceReason: 'presence_missing',
          }),
        ],
      }),
    ]);

    expect(harness.elements.summary.childNodes.length).toBeGreaterThan(1);
    expect(getSummaryCountTexts(harness.elements.summary)).toEqual(['1 live', '1 stale']);
    expect(harness.elements.summary.childNodes.every((child) => child instanceof FakeElement)).toBe(
      true,
    );
    expandAllRepoGroups(harness.elements.list);
    expect(findAllByClass(harness.elements.summary, 'summary-meta')[0]?.textContent).toContain(
      'updated ',
    );
    expect(getCards(harness.elements.list)).toHaveLength(2);

    setShowAll(harness.elements, true);

    expect(getSummaryCountTexts(harness.elements.summary)).toEqual([
      '1 live',
      '1 stale',
      '1 dead',
      '1 unknown',
    ]);
    expect(findAllByClass(harness.elements.summary, 'summary-meta')[0]?.textContent).toContain(
      'updated ',
    );
    expect(getCards(harness.elements.list)).toHaveLength(4);
  });

  it('renders cards collapsed inside an expanded repo and toggles expansion inline', async () => {
    const harness = await setupApp([
      buildSnapshot({
        records: [
          buildRecord({
            derivedFacets: {
              persistence: 'file_backed',
              rowKind: 'durable_session',
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
    expandAllRepoGroups(harness.elements.list);

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
    expandAllRepoGroups(harness.elements.list);

    const card = getCards(harness.elements.list)[0]!;
    const line1 = getCardLine(card, 'row-line1');
    const line2 = getCardLine(card, 'row-line2');

    const activityIcons = findAllByClass(line1, 'activity-icon');
    expect(activityIcons).toHaveLength(1);
    expect(activityIcons[0]?.getAttribute('role')).toBe('img');
    expect(activityIcons[0]?.getAttribute('aria-label')).toBe('idle');
    expect(activityIcons[0]?.getAttribute('title')).toBe('idle');
    expect(findAllByClass(line1, 'status-icon')).toHaveLength(0);
    expect(getChildTextContents(line1)).toEqual(['', 'gbt baseline', 'live', '5s']);
    expect(findAllByClass(line1, 'row-activity')[0]?.textContent).toBe('live');
    expect(line1.textContent).not.toContain('idle');
    expect(findAllByClass(line1, 'row-age')[0]?.textContent).toBe('5s');
    expect(getChildTextContents(line2)).toEqual(['shop-ml', '#22722', 'rh-baseline-gbdt']);
  });

  it('renders one Open button sibling for each real card and none for pending worktree cards', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url === '/snapshot.json') {
        return Promise.resolve(
          buildJsonResponse(
            buildSnapshot({
              records: [
                buildRecord(),
                buildRecord({ runtimeId: 'rt-2', sessionId: 'session-2', sessionName: 'bravo' }),
              ],
            }),
          ),
        );
      }
      if (url === '/actions/create-worktree-preview') {
        return Promise.resolve(buildJsonResponse(buildBasePreview()));
      }
      if (url === '/actions/create-worktree') {
        return new Promise(() => {});
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    const harness = await setupAppWithFetch(fetchMock);
    expandAllRepoGroups(harness.elements.list);

    const cards = getCards(harness.elements.list);
    expect(cards).toHaveLength(2);
    expect(findAllByClass(harness.elements.list, 'card-open')).toHaveLength(2);

    for (const card of cards) {
      const toggle = getCardToggle(card);
      const openButton = getCardOpenButton(card);
      expect(card.childNodes[0]).toBe(toggle);
      expect(card.childNodes[1]).toBe(openButton);
      expect(openButton.parentNode).toBe(card);
      expect(findAllByTag(toggle, 'button')).toHaveLength(0);
      expect(openButton.type).toBe('button');
      expect(openButton.textContent).toBe('↗');
      expect(openButton.getAttribute('aria-expanded')).toBeNull();
      expect(openButton.getAttribute('aria-controls')).toBeNull();
      expect(openButton.getAttribute('title')).toBe(openButton.getAttribute('aria-label'));
      expect(findAllByClass(getCardLine(card, 'row-line1'), 'row-age')).toHaveLength(1);
    }

    expect(getCardOpenButton(cards[0]!).getAttribute('aria-label')).toBe('Open terminal for alpha');
    expect(getCardOpenButton(cards[1]!).getAttribute('aria-label')).toBe('Open terminal for bravo');

    getRepoActionButton(getRepoGroupByLabel(harness.elements.list, 'owner/project')).click();
    await flushMicrotasks();

    const form = findAllByClass(
      getRepoGroupByLabel(harness.elements.list, 'owner/project'),
      'worktree-form',
    )[0]!;
    const branchInput = findAllByTag(form, 'input').find(
      (input) => input.getAttribute('aria-label') === 'Branch name',
    ) as FakeInputElement;
    branchInput.value = 'rh/open-card';
    branchInput.dispatchEvent({ type: 'input' });
    form.dispatchEvent({ type: 'submit' });
    await flushMicrotasks();

    const pendingCards = getPendingWorktreeCards(harness.elements.list);
    expect(pendingCards).toHaveLength(1);
    expect(findAllByClass(pendingCards[0]!, 'card-open')).toHaveLength(0);
    expect(findAllByClass(harness.elements.list, 'card-open')).toHaveLength(2);
  });

  it('posts exact authenticated Open requests without changing disclosure state', async () => {
    const fetchMock = vi.fn((url: string, _init?: unknown) => {
      if (url === '/snapshot.json') {
        return Promise.resolve(buildJsonResponse(buildSnapshot()));
      }
      if (url === '/actions/open-terminal') {
        return Promise.resolve(
          buildJsonResponse({ ok: true, status: 'requested', message: 'Terminal open requested.' }),
        );
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    const harness = await setupAppWithFetch(fetchMock);
    expandAllRepoGroups(harness.elements.list);

    getCardToggle(getCards(harness.elements.list)[0]!).click();
    expect(getExpandedCardTitles(harness.elements.list)).toEqual(['alpha']);

    const preventDefault = vi.fn();
    const stopPropagation = vi.fn();
    getCardOpenButton(getExpandedCards(harness.elements.list)[0]!).dispatchEvent({
      type: 'click',
      preventDefault,
      stopPropagation,
    });
    await flushMicrotasks();

    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(stopPropagation).toHaveBeenCalledTimes(1);
    expect(getExpandedCardTitles(harness.elements.list)).toEqual(['alpha']);

    const openCall = fetchMock.mock.calls.find(([url]) => url === '/actions/open-terminal');
    expect(openCall).toBeDefined();
    const requestInit = openCall![1] as {
      method?: string;
      cache?: string;
      headers?: Record<string, string>;
      body?: string;
    };
    expect(requestInit.method).toBe('POST');
    expect(requestInit.cache).toBe('no-store');
    expect(requestInit.headers).toMatchObject({
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'X-Session-Deck-Action-Token': 'test-token',
    });
    expect(JSON.parse(requestInit.body ?? '{}')).toEqual({ runtimeId: 'rt-1' });
    expect(Object.keys(JSON.parse(requestInit.body ?? '{}'))).toEqual(['runtimeId']);
  });

  it('renders End session only in expanded details and posts exact authenticated Kill requests after confirmation', async () => {
    const fetchMock = vi.fn((url: string, _init?: unknown) => {
      if (url === '/snapshot.json') {
        return Promise.resolve(buildJsonResponse(buildSnapshot()));
      }
      if (url === '/actions/kill-session') {
        return Promise.resolve(
          buildJsonResponse({
            ok: true,
            status: 'requested',
            message: 'Helper success copy should not render.',
          }),
        );
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    const harness = await setupAppWithFetch(fetchMock);
    expandAllRepoGroups(harness.elements.list);

    expect(findAllByClass(harness.elements.list, 'stop-action-button')).toHaveLength(0);
    expect(findAllByClass(harness.elements.list, 'card-open')).toHaveLength(1);

    getCardToggle(getCards(harness.elements.list)[0]!).click();
    const detail = getCardDetail(getExpandedCards(harness.elements.list)[0]!);
    const stopButton = findAllByClass(detail, 'stop-action-button')[0] as FakeButtonElement;
    expect(stopButton.textContent).toBe('End session');

    stopButton.click();
    await flushMicrotasks();

    expect(fetchMock.mock.calls.filter(([url]) => url === '/actions/kill-session')).toHaveLength(0);
    expect(harness.elements.list.textContent).toContain(
      'Ending this session sends SIGTERM to the Pi runtime only. Session history is preserved.',
    );
    expect(harness.elements.list.textContent).not.toContain(
      'Session Deck does not explicitly close iTerm or kill tmux',
    );

    const confirm = findAllByClass(
      harness.elements.list,
      'stop-confirm-primary',
    )[0] as FakeButtonElement;
    expect(confirm.textContent).toBe('End session');
    confirm.click();
    await flushMicrotasks();

    const killCall = fetchMock.mock.calls.find(([url]) => url === '/actions/kill-session');
    expect(killCall).toBeDefined();
    const requestInit = killCall![1] as {
      method?: string;
      cache?: string;
      headers?: Record<string, string>;
      body?: string;
    };
    expect(requestInit.method).toBe('POST');
    expect(requestInit.cache).toBe('no-store');
    expect(requestInit.headers).toMatchObject({
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'X-Session-Deck-Action-Token': 'test-token',
    });
    expect(JSON.parse(requestInit.body ?? '{}')).toEqual({ runtimeId: 'rt-1' });
    expect(Object.keys(JSON.parse(requestInit.body ?? '{}'))).toEqual(['runtimeId']);
    expect(harness.elements.list.textContent).toContain('End requested for this session.');
    expect(harness.elements.list.textContent).not.toContain(
      'Helper success copy should not render.',
    );
    expect(harness.elements.list.textContent).not.toContain('killed');
  });

  it('renders End session failure copy from reason instead of helper text', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url === '/snapshot.json') {
        return Promise.resolve(buildJsonResponse(buildSnapshot()));
      }
      if (url === '/actions/kill-session') {
        return Promise.resolve(
          buildJsonResponse({
            ok: false,
            status: 'failed',
            reason: 'signal-failed',
            message: 'Helper failure copy should not render.',
          }),
        );
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    const harness = await setupAppWithFetch(fetchMock);
    expandAllRepoGroups(harness.elements.list);

    getCardToggle(getCards(harness.elements.list)[0]!).click();
    (findAllByClass(harness.elements.list, 'stop-action-button')[0] as FakeButtonElement).click();
    (findAllByClass(harness.elements.list, 'stop-confirm-primary')[0] as FakeButtonElement).click();
    await flushMicrotasks();

    expect(harness.elements.list.textContent).toContain('Could not request session end.');
    expect(harness.elements.list.textContent).not.toContain(
      'Helper failure copy should not render.',
    );
  });

  it('cancels End session confirmation without posting on cancel, detail collapse, or show-all hiding', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url === '/snapshot.json') {
        return Promise.resolve(
          buildJsonResponse(
            buildSnapshot({
              records: [buildRecord({ presenceState: 'dead', presenceReason: 'pid_missing' })],
            }),
          ),
        );
      }
      if (url === '/actions/kill-session') {
        return Promise.resolve(
          buildJsonResponse({
            ok: true,
            status: 'requested',
            message: 'End requested for this session.',
          }),
        );
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    const harness = await setupAppWithFetch(fetchMock);

    setShowAll(harness.elements, true);
    expandAllRepoGroups(harness.elements.list);
    getCardToggle(getCards(harness.elements.list)[0]!).click();

    (findAllByClass(harness.elements.list, 'stop-action-button')[0] as FakeButtonElement).click();
    expect(findAllByClass(harness.elements.list, 'stop-confirmation')).toHaveLength(1);
    (findAllByClass(harness.elements.list, 'stop-confirm')[1] as FakeButtonElement).click();
    expect(findAllByClass(harness.elements.list, 'stop-confirmation')).toHaveLength(0);

    (findAllByClass(harness.elements.list, 'stop-action-button')[0] as FakeButtonElement).click();
    getCardToggle(getExpandedCards(harness.elements.list)[0]!).click();
    expect(findAllByClass(harness.elements.list, 'stop-confirmation')).toHaveLength(0);

    getCardToggle(getCards(harness.elements.list)[0]!).click();
    (findAllByClass(harness.elements.list, 'stop-action-button')[0] as FakeButtonElement).click();
    setShowAll(harness.elements, false);
    expect(findAllByClass(harness.elements.list, 'stop-confirmation')).toHaveLength(0);
    expect(fetchMock.mock.calls.filter(([url]) => url === '/actions/kill-session')).toHaveLength(0);
  });

  it('keeps one pending End session request and ignores stale completion after confirmation is replaced', async () => {
    const killRequest = {
      resolve: null as ((response: ReturnType<typeof buildJsonResponse>) => void) | null,
    };
    const fetchMock = vi.fn((url: string) => {
      if (url === '/snapshot.json') {
        return Promise.resolve(
          buildJsonResponse(
            buildSnapshot({
              records: [
                buildRecord(),
                buildRecord({ runtimeId: 'rt-2', sessionId: 'session-2', sessionName: 'bravo' }),
              ],
            }),
          ),
        );
      }
      if (url === '/actions/kill-session') {
        return new Promise<ReturnType<typeof buildJsonResponse>>((resolve) => {
          killRequest.resolve = resolve;
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    const harness = await setupAppWithFetch(fetchMock);
    expandAllRepoGroups(harness.elements.list);

    getCardToggle(getCards(harness.elements.list)[0]!).click();
    (findAllByClass(harness.elements.list, 'stop-action-button')[0] as FakeButtonElement).click();
    (findAllByClass(harness.elements.list, 'stop-confirm-primary')[0] as FakeButtonElement).click();
    await flushMicrotasks();

    expect(fetchMock.mock.calls.filter(([url]) => url === '/actions/kill-session')).toHaveLength(1);
    expect(
      findAllByClass(harness.elements.list, 'stop-action-button').map(
        (button) => (button as FakeButtonElement).disabled,
      ),
    ).toEqual([true]);

    killRequest.resolve?.(
      buildJsonResponse({
        ok: true,
        status: 'already-exited',
        message: 'This Pi session is no longer running.',
      }),
    );
    await flushMicrotasks();

    expect(harness.elements.list.textContent).toContain('This Pi session is no longer running.');
  });

  it('keeps one pending Open request and disables all Open buttons until it resolves', async () => {
    const openRequest = {
      resolve: null as ((response: ReturnType<typeof buildJsonResponse>) => void) | null,
    };
    const fetchMock = vi.fn((url: string) => {
      if (url === '/snapshot.json') {
        return Promise.resolve(
          buildJsonResponse(
            buildSnapshot({
              records: [
                buildRecord(),
                buildRecord({ runtimeId: 'rt-2', sessionId: 'session-2', sessionName: 'bravo' }),
              ],
            }),
          ),
        );
      }
      if (url === '/actions/open-terminal') {
        return new Promise<ReturnType<typeof buildJsonResponse>>((resolve) => {
          openRequest.resolve = resolve;
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    const harness = await setupAppWithFetch(fetchMock);
    expandAllRepoGroups(harness.elements.list);

    getCardOpenButton(getCards(harness.elements.list)[0]!).click();

    expect(fetchMock.mock.calls.filter(([url]) => url === '/actions/open-terminal')).toHaveLength(
      1,
    );
    const pendingButtons = getCards(harness.elements.list).map(getCardOpenButton);
    expect(pendingButtons.map((button) => button.disabled)).toEqual([true, true]);
    expect(pendingButtons.map((button) => button.textContent)).toEqual(['↗', '↗']);
    expect(pendingButtons[0]?.getAttribute('data-state')).toBe('pending');

    pendingButtons[0]?.click();
    pendingButtons[1]?.click();

    expect(fetchMock.mock.calls.filter(([url]) => url === '/actions/open-terminal')).toHaveLength(
      1,
    );

    openRequest.resolve?.(
      buildJsonResponse({ ok: true, status: 'requested', message: 'Terminal open requested.' }),
    );
    await flushMicrotasks();

    const resolvedButtons = getCards(harness.elements.list).map(getCardOpenButton);
    expect(resolvedButtons.map((button) => button.disabled)).toEqual([false, false]);
    expect(resolvedButtons[0]?.textContent).toBe('✓');
    expect(resolvedButtons[0]?.getAttribute('data-state')).toBe('success');
    expect(resolvedButtons[1]?.textContent).toBe('↗');
  });

  it('renders retryable persistent Open failure feedback', async () => {
    let openRequestCount = 0;
    const fetchMock = vi.fn((url: string) => {
      if (url === '/snapshot.json') {
        return Promise.resolve(buildJsonResponse(buildSnapshot()));
      }
      if (url === '/actions/open-terminal') {
        openRequestCount += 1;
        return Promise.resolve(
          openRequestCount === 1
            ? buildJsonResponse({
                ok: false,
                status: 'failed',
                reason: 'terminal-missing',
                message: 'No openable terminal target is available for this session.',
              })
            : buildJsonResponse({
                ok: true,
                status: 'requested',
                message: 'Terminal open requested.',
              }),
        );
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    const harness = await setupAppWithFetch(fetchMock);
    expandAllRepoGroups(harness.elements.list);

    getCardOpenButton(getCards(harness.elements.list)[0]!).click();
    await flushMicrotasks();

    const failedButton = getCardOpenButton(getCards(harness.elements.list)[0]!);
    expect(failedButton.disabled).toBe(false);
    expect(failedButton.textContent).toBe('!');
    expect(failedButton.getAttribute('data-state')).toBe('failure');
    expect(failedButton.getAttribute('aria-label')).toBe(
      'Open terminal failed for alpha: No openable terminal target is available for this session.',
    );
    expect(failedButton.getAttribute('title')).toBe(failedButton.getAttribute('aria-label'));

    failedButton.click();
    await flushMicrotasks();

    expect(fetchMock.mock.calls.filter(([url]) => url === '/actions/open-terminal')).toHaveLength(
      2,
    );
    expect(getCardOpenButton(getCards(harness.elements.list)[0]!).textContent).toBe('✓');
  });

  it('reconciles pending Open state across refresh and row disappearance', async () => {
    const snapshots = [
      buildSnapshot(),
      buildSnapshot({ records: [buildRecord({ sessionName: 'alpha refreshed' })] }),
      buildSnapshot({ records: [] }),
      buildSnapshot(),
    ];
    const openRequest = {
      resolve: null as ((response: ReturnType<typeof buildJsonResponse>) => void) | null,
    };
    const fetchMock = vi.fn((url: string) => {
      if (url === '/snapshot.json') {
        const snapshot = snapshots.shift();
        if (!snapshot) {
          throw new Error('Unexpected snapshot fetch.');
        }
        return Promise.resolve(buildJsonResponse(snapshot));
      }
      if (url === '/actions/open-terminal') {
        return new Promise<ReturnType<typeof buildJsonResponse>>((resolve) => {
          openRequest.resolve = resolve;
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    const harness = await setupAppWithFetch(fetchMock);
    expandAllRepoGroups(harness.elements.list);

    getCardOpenButton(getCards(harness.elements.list)[0]!).click();
    expect(getCardOpenButton(getCards(harness.elements.list)[0]!).disabled).toBe(true);

    harness.elements.refresh.click();
    await flushMicrotasks();

    expect(getCards(harness.elements.list)).toHaveLength(1);
    expect(getCardOpenButton(getCards(harness.elements.list)[0]!).disabled).toBe(true);
    expect(getCardOpenButton(getCards(harness.elements.list)[0]!).getAttribute('data-state')).toBe(
      'pending',
    );

    harness.elements.refresh.click();
    await flushMicrotasks();

    expect(getCards(harness.elements.list)).toHaveLength(0);

    harness.elements.refresh.click();
    await flushMicrotasks();
    expandAllRepoGroups(harness.elements.list);

    const returnedButton = getCardOpenButton(getCards(harness.elements.list)[0]!);
    expect(returnedButton.disabled).toBe(false);
    expect(returnedButton.textContent).toBe('↗');
    expect(returnedButton.getAttribute('data-state')).toBeNull();

    openRequest.resolve?.(
      buildJsonResponse({ ok: true, status: 'requested', message: 'Terminal open requested.' }),
    );
    await flushMicrotasks();

    expect(getCardOpenButton(getCards(harness.elements.list)[0]!).textContent).toBe('↗');
  });

  it('clears pending Open state when show-all hides the runtime', async () => {
    const openRequest = {
      resolve: null as ((response: ReturnType<typeof buildJsonResponse>) => void) | null,
    };
    const fetchMock = vi.fn((url: string) => {
      if (url === '/snapshot.json') {
        return Promise.resolve(
          buildJsonResponse(
            buildSnapshot({
              records: [
                buildRecord(),
                buildRecord({
                  runtimeId: 'rt-dead',
                  sessionId: 'session-dead',
                  sessionName: 'dead session',
                  presenceState: 'dead',
                }),
              ],
            }),
          ),
        );
      }
      if (url === '/actions/open-terminal') {
        return new Promise<ReturnType<typeof buildJsonResponse>>((resolve) => {
          openRequest.resolve = resolve;
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    const harness = await setupAppWithFetch(fetchMock);
    setShowAll(harness.elements, true);
    expandAllRepoGroups(harness.elements.list);

    getCardOpenButton(getCards(harness.elements.list)[1]!).click();
    expect(getCardOpenButton(getCards(harness.elements.list)[1]!).disabled).toBe(true);

    setShowAll(harness.elements, false);
    expect(getCards(harness.elements.list)).toHaveLength(1);

    setShowAll(harness.elements, true);
    expandAllRepoGroups(harness.elements.list);

    const deadOpenButton = getCardOpenButton(getCards(harness.elements.list)[1]!);
    expect(deadOpenButton.disabled).toBe(false);
    expect(deadOpenButton.textContent).toBe('↗');
    expect(deadOpenButton.getAttribute('data-state')).toBeNull();

    openRequest.resolve?.(
      buildJsonResponse({ ok: true, status: 'requested', message: 'Terminal open requested.' }),
    );
    await flushMicrotasks();

    expect(getCardOpenButton(getCards(harness.elements.list)[1]!).textContent).toBe('↗');
  });

  it('renders thinking as one accessible brain icon with a CSS orbit affordance', async () => {
    const harness = await setupApp([
      buildSnapshot({
        records: [
          buildRecord({
            activityState: 'thinking',
            activityAgeMs: 12_000,
            heartbeatAgeMs: 4_000,
          }),
        ],
      }),
    ]);
    expandAllRepoGroups(harness.elements.list);

    const card = getCards(harness.elements.list)[0]!;
    const line1 = getCardLine(card, 'row-line1');
    const activityIcons = findAllByClass(line1, 'activity-icon');

    expect(activityIcons).toHaveLength(1);
    expect(activityIcons[0]?.getAttribute('role')).toBe('img');
    expect(activityIcons[0]?.getAttribute('aria-label')).toBe('thinking');
    expect(activityIcons[0]?.getAttribute('title')).toBe('thinking');
    expect(activityIcons[0]?.getAttribute('data-activity')).toBe('thinking');
    expect(findAllByClass(line1, 'activity-icon-thinking-orbit')).toHaveLength(1);
    expect(findAllByClass(line1, 'status-icon')).toHaveLength(0);
    expect(getChildTextContents(line1)).toEqual(['', 'alpha', 'thinking', '12s']);
    expect(findAllByClass(line1, 'row-activity')[0]?.textContent).toBe('thinking');
  });

  it('renders compacting as an accessible activity icon without chips', async () => {
    const harness = await setupApp([
      buildSnapshot({
        records: [
          buildRecord({
            activityState: 'compacting',
            activityAgeMs: 15_000,
            chips: [],
            compaction: {
              state: 'running',
              ageMs: 15_000,
              startedAt: '2026-07-10T20:14:45.000Z',
              reason: 'manual',
              willRetry: false,
            },
          }),
        ],
      }),
    ]);
    expandAllRepoGroups(harness.elements.list);

    const card = getCards(harness.elements.list)[0]!;
    const line1 = getCardLine(card, 'row-line1');
    const activityIcons = findAllByClass(line1, 'activity-icon');

    expect(activityIcons).toHaveLength(1);
    expect(activityIcons[0]?.getAttribute('role')).toBe('img');
    expect(activityIcons[0]?.getAttribute('aria-label')).toBe('compacting');
    expect(activityIcons[0]?.getAttribute('title')).toBe('compacting');
    expect(activityIcons[0]?.getAttribute('data-activity')).toBe('compacting');
    expect(getChildTextContents(line1)).toEqual(['', 'alpha', 'compacting', '15s']);
    expect(findAllByClass(card, 'chips-inline')).toHaveLength(0);

    getCardToggle(card).click();
    const status = getDetailSection(
      getCardDetail(getExpandedCards(harness.elements.list)[0]!),
      'STATUS',
    );
    expect(getDetailRowLabels(status)).toEqual(['Activity', 'Compaction']);
    expect(getDetailRowValues(status)).toEqual(['compacting', 'running · 15s · manual']);
  });

  it('renders subsecond card ages as <1s and preserves larger duration units', async () => {
    const harness = await setupApp([
      buildSnapshot({
        records: [
          buildRecord({
            runtimeId: 'rt-subsecond',
            sessionId: 'session-subsecond',
            sessionName: 'subsecond',
            heartbeatAgeMs: 999,
          }),
          buildRecord({
            runtimeId: 'rt-one-second',
            sessionId: 'session-one-second',
            sessionName: 'one second',
            heartbeatAgeMs: 1_000,
          }),
          buildRecord({
            runtimeId: 'rt-minute',
            sessionId: 'session-minute',
            sessionName: 'minute',
            heartbeatAgeMs: 60_000,
          }),
          buildRecord({
            runtimeId: 'rt-hour',
            sessionId: 'session-hour',
            sessionName: 'hour',
            heartbeatAgeMs: 60 * 60_000,
          }),
        ],
      }),
    ]);
    expandAllRepoGroups(harness.elements.list);

    expect(
      getCards(harness.elements.list).map(
        (card) => findAllByClass(getCardLine(card, 'row-line1'), 'row-age')[0]?.textContent,
      ),
    ).toEqual(['<1s', '1s', '1m', '1h']);
  });

  it('shows tool-running as one accessible icon and keeps the age visible once', async () => {
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
    expandAllRepoGroups(harness.elements.list);

    const card = getCards(harness.elements.list)[0]!;
    const line1 = getCardLine(card, 'row-line1');
    const line2 = getCardLine(card, 'row-line2');

    const activityIcons = findAllByClass(line1, 'activity-icon');
    expect(activityIcons).toHaveLength(1);
    expect(activityIcons[0]?.getAttribute('aria-label')).toBe('tool-running: bash');
    expect(activityIcons[0]?.getAttribute('title')).toBe('tool-running: bash');
    expect(activityIcons[0]?.getAttribute('data-activity')).toBe('tool-running');
    expect(findAllByClass(line1, 'activity-icon-thinking-orbit')).toHaveLength(0);
    expect(findAllByClass(line1, 'status-icon')).toHaveLength(0);
    expect(getChildTextContents(line1)).toEqual(['', 'alpha', 'tool-running', '12s']);
    expect(findAllByClass(line1, 'row-activity')[0]?.textContent).toBe('tool-running');
    expect(line1.textContent).not.toContain('bash');
    expect(line1.textContent.match(/12s/gu) ?? []).toHaveLength(1);
    expect(line2.textContent).not.toContain('12s');

    getCardToggle(card).click();

    const detail = getCardDetail(getExpandedCards(harness.elements.list)[0]!);
    const status = getDetailSection(detail, 'STATUS');
    expect(getDetailRowLabels(status)).toEqual(['Current tool']);
    expect(getDetailRowValues(status)).toEqual(['bash']);
  });

  it('clamps collapsed header chips and keeps the full upstream chip list in expanded STATUS', async () => {
    const harness = await setupApp([
      buildSnapshot({
        records: [
          buildRecord({
            runtimeId: 'rt-0',
            sessionId: 'session-0',
            sessionName: 'zero',
            chips: [],
          }),
          buildRecord({
            runtimeId: 'rt-1b',
            sessionId: 'session-1b',
            sessionName: 'one',
            chips: ['solo'],
          }),
          buildRecord({
            runtimeId: 'rt-2',
            sessionId: 'session-2',
            sessionName: 'two',
            chips: ['first', 'second'],
          }),
          buildRecord({
            runtimeId: 'rt-3',
            sessionId: 'session-3',
            sessionName: 'many',
            chips: ['gamma', 'alpha', 'beta', 'delta'],
          }),
        ],
      }),
    ]);
    expandAllRepoGroups(harness.elements.list);

    const [zeroCard, oneCard, twoCard, manyCard] = getCards(harness.elements.list);

    expect(findAllByClass(zeroCard!, 'chips-inline')).toHaveLength(0);
    expect(getInlineChipTexts(oneCard!)).toEqual(['solo']);
    expect(getInlineChipTexts(twoCard!)).toEqual(['first', 'second']);
    expect(getInlineChipTexts(manyCard!)).toEqual(['gamma', 'alpha', '+2']);
    expect(findAllByClass(manyCard!, 'chip-subtle').map((chip) => chip.textContent)).toEqual([
      '+2',
    ]);

    getCardToggle(manyCard!).click();

    const expandedCard = getExpandedCards(harness.elements.list)[0]!;
    expect(findAllByClass(expandedCard, 'chips-inline')).toHaveLength(0);

    const status = getDetailSection(getCardDetail(expandedCard), 'STATUS');
    expect(getChipTexts(status)).toEqual(['gamma', 'alpha', 'beta', 'delta']);
    expect(findAllByClass(status, 'chip-subtle')).toHaveLength(0);
  });

  it('starts expanded detail at IDENTITY and keeps workspace copy buttons with PR last', async () => {
    const longSessionId = 'session-0123456789abcdef-0123456789abcdef';
    const longRuntimeId = 'runtime-0123456789abcdef-0123456789abcdef';
    const cwd = `${HOME}/src/github.com/Shopify/worktrees/shop-ml-pr22623-rankerspec-uses-pipeline`;
    const shortenedCwd =
      '~/src/github.com/Shopify/worktrees/shop-ml-pr22623-rankerspec-uses-pipeline';
    const harness = await setupApp([
      buildSnapshot({
        records: [
          buildRecord({
            sessionId: longSessionId,
            runtimeId: longRuntimeId,
            sessionName: 'gbdt rankerspec',
            repoName: 'shop-ml',
            qualifiedRepoName: 'Shopify/shop-ml',
            cwd,
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
    expandAllRepoGroups(harness.elements.list);

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
    const sessionIdValue = getDetailRowValue(identity, 'Session ID');
    const runtimeIdValue = getDetailRowValue(identity, 'Runtime ID');
    expect(sessionIdValue.classList.contains('detail-value-middle')).toBe(true);
    expect(sessionIdValue.getAttribute('title')).toBe(longSessionId);
    expect(getChildTextContents(sessionIdValue).join('')).toBe(longSessionId);
    expect(runtimeIdValue.classList.contains('detail-value-middle')).toBe(true);
    expect(runtimeIdValue.getAttribute('title')).toBe(longRuntimeId);
    expect(getChildTextContents(runtimeIdValue).join('')).toBe(longRuntimeId);

    const workspace = getDetailSection(detail, 'WORKSPACE');
    expect(getDetailRowLabels(workspace)).toEqual(['CWD', 'Branch', 'Repo', 'Checkout', 'PR']);
    expect(getDetailRowValues(workspace)).toEqual([
      shortenedCwd,
      'rh-baseline-gbdt-rankerspec-uses-pipeline',
      'Shopify/shop-ml',
      'worktree · shop-ml-pr22623-rankerspec-uses-pipeline',
      '#22623',
    ]);
    const cwdValue = getDetailRowValue(workspace, 'CWD');
    expect(cwdValue.classList.contains('detail-value-middle')).toBe(true);
    expect(cwdValue.getAttribute('title')).toBe(shortenedCwd);
    expect(getChildTextContents(cwdValue).join('')).toBe(shortenedCwd);

    const prValue = getDetailRowValue(workspace, 'PR');
    expect(prValue.tagName).toBe('A');
    expect(prValue.classList.contains('detail-link')).toBe(true);
    expect(prValue.getAttribute('href')).toBe('https://github.com/Shopify/shop-ml/pull/22623');
    expect(prValue.getAttribute('target')).toBe('_blank');
    expect(prValue.getAttribute('rel')).toBe('noreferrer');
    prValue.click();
    expect(harness.openMock).toHaveBeenCalledWith(
      'https://github.com/Shopify/shop-ml/pull/22623',
      '_blank',
      'noopener,noreferrer',
    );
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
    expect(findAllByClass(detail, 'stop-action-button')[0]?.textContent).toBe('End session');

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
    expandAllRepoGroups(harness.elements.list);

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
    expandAllRepoGroups(harness.elements.list);

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
    expandAllRepoGroups(harness.elements.list);

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
    expandAllRepoGroups(harness.elements.list);

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
    expandAllRepoGroups(harness.elements.list);
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
    expandAllRepoGroups(harness.elements.list);
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
    expandAllRepoGroups(harness.elements.list);

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

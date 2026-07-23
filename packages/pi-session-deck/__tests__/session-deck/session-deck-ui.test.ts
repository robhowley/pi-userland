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
      stopPropagation() {},
      ...event,
    };
    for (const listener of this.listeners.get(event.type) ?? []) {
      listener(normalizedEvent);
    }
    return true;
  }

  click(): void {
    this.dispatchEvent({ type: 'click', preventDefault() {}, stopPropagation() {} });
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

  createElementNS(_namespace: string, tagName: string): FakeElement {
    return this.createElement(tagName);
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

interface ScheduledTimeout {
  id: number;
  ms: number;
  callback: () => void;
}

interface SharedUiHarness {
  elements: HarnessElements;
  createWorktreeMock: ReturnType<typeof vi.fn>;
  copyTextMock: ReturnType<typeof vi.fn>;
  loadSnapshotMock: ReturnType<typeof vi.fn>;
  openExternalMock: ReturnType<typeof vi.fn>;
  openTerminalMock: ReturnType<typeof vi.fn>;
  previewMock: ReturnType<typeof vi.fn>;
  pushSnapshot: (snapshot: unknown) => void;
  runTimeout: (ms: number) => Promise<void>;
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
    diagnostics?: SessionDeckDiagnostic[];
    records?: SessionDeckRecord[];
  } = {},
): SessionDeckSnapshot {
  return {
    generatedAt: '2026-07-10T20:15:00.000Z',
    records: options.records ?? [buildRecord()],
    diagnostics: options.diagnostics ?? [],
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
  setIntervalMock,
  setTimeoutMock,
  clearTimeoutMock,
}: {
  clearTimeoutMock: ReturnType<typeof vi.fn>;
  document: FakeDocument;
  setIntervalMock: ReturnType<typeof vi.fn>;
  setTimeoutMock: ReturnType<typeof vi.fn>;
}): () => void {
  const previous = {
    document: Reflect.get(globalThis, 'document'),
    window: Reflect.get(globalThis, 'window'),
    htmlButtonElement: Reflect.get(globalThis, 'HTMLButtonElement'),
    htmlInputElement: Reflect.get(globalThis, 'HTMLInputElement'),
  };

  Reflect.set(globalThis, 'document', document);
  Reflect.set(globalThis, 'window', {
    clearTimeout: clearTimeoutMock,
    setInterval: setIntervalMock,
    setTimeout: setTimeoutMock,
  });
  Reflect.set(globalThis, 'HTMLButtonElement', FakeButtonElement);
  Reflect.set(globalThis, 'HTMLInputElement', FakeInputElement);

  return () => {
    restoreGlobal('document', previous.document);
    restoreGlobal('window', previous.window);
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

async function importFreshSharedUi(): Promise<void> {
  const moduleUrl = new URL(
    '../../extensions/session-deck/iterm2/web/session-deck-ui.js',
    import.meta.url,
  );
  moduleUrl.searchParams.set('t', `${Date.now()}-${Math.random()}`);
  await import(moduleUrl.href);
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

async function setupSharedUi(
  options: {
    copyText?: ReturnType<typeof vi.fn>;
    createWorktree?: ReturnType<typeof vi.fn>;
    loadSnapshot?: ReturnType<typeof vi.fn>;
    openExternal?: ReturnType<typeof vi.fn>;
    openTerminal?: ReturnType<typeof vi.fn>;
    previewWorktreeBaseRef?: ReturnType<typeof vi.fn>;
    snapshots?: unknown[];
  } = {},
): Promise<SharedUiHarness> {
  const document = new FakeDocument();
  const elements = buildElements(document);
  const snapshotQueue = [...(options.snapshots ?? [buildSnapshot()])];
  const scheduledTimeouts = new Map<number, ScheduledTimeout>();
  let nextTimerId = 1;

  const setIntervalMock = vi.fn(() => nextTimerId++);
  const setTimeoutMock = vi.fn((callback: () => void, ms: number) => {
    const id = nextTimerId++;
    scheduledTimeouts.set(id, { id, ms, callback });
    return id;
  });
  const clearTimeoutMock = vi.fn((id: number) => {
    scheduledTimeouts.delete(id);
  });

  cleanupGlobals = installBrowserGlobals({
    document,
    setIntervalMock,
    setTimeoutMock,
    clearTimeoutMock,
  });

  const loadSnapshotMock =
    options.loadSnapshot ??
    vi.fn(async () => {
      if (snapshotQueue.length === 0) {
        throw new Error('Unexpected snapshot load.');
      }

      const nextSnapshot = snapshotQueue.shift();
      if (nextSnapshot instanceof Error) {
        throw nextSnapshot;
      }
      return nextSnapshot;
    });
  const previewMock =
    options.previewWorktreeBaseRef ??
    vi.fn(async () => ({ ok: true, status: 'resolved', baseRef: 'origin/main' }));
  const createWorktreeMock = options.createWorktree ?? vi.fn();
  const openTerminalMock = options.openTerminal ?? vi.fn();
  const openExternalMock = options.openExternal ?? vi.fn(async () => ({ ok: true }));
  const copyTextMock = options.copyText ?? vi.fn(async () => ({ ok: true }));

  await importFreshSharedUi();
  const windowLike = Reflect.get(globalThis, 'window') as {
    SessionDeckUI: { mount: (options: unknown) => unknown };
  };
  windowLike.SessionDeckUI.mount({
    document,
    host: {
      copyText: copyTextMock,
      createWorktree: createWorktreeMock,
      doctorCommand: '/session-deck iterm2 doctor',
      loadSnapshot: loadSnapshotMock,
      openExternal: openExternalMock,
      createSession: vi.fn(),
      killSession: vi.fn(),
      openTerminal: openTerminalMock,
      previewWorktreeBaseRef: previewMock,
      previewWorktreeLaunchContext: vi.fn(async () => ({
        ok: true,
        status: 'resolved',
        effectiveDisplay: 'Current',
      })),
    },
    window: windowLike,
  });
  await flushMicrotasks();

  return {
    elements,
    createWorktreeMock,
    copyTextMock,
    loadSnapshotMock,
    openExternalMock,
    openTerminalMock,
    previewMock,
    pushSnapshot: (snapshot) => {
      snapshotQueue.push(snapshot);
    },
    runTimeout: async (ms) => {
      const timeout = [...scheduledTimeouts.values()].find((candidate) => candidate.ms === ms);
      if (!timeout) {
        throw new Error(`Expected timeout ${ms}.`);
      }
      scheduledTimeouts.delete(timeout.id);
      timeout.callback();
      await flushMicrotasks();
    },
  };
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

function getRepoGroups(list: FakeElement): FakeElement[] {
  return list.childNodes.filter(
    (child): child is FakeElement =>
      child instanceof FakeElement && child.classList.contains('repo-group'),
  );
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

function getCards(root: FakeNode): FakeElement[] {
  return findAllByClass(root, 'card');
}

function getPendingWorktreeCards(root: FakeNode): FakeElement[] {
  return findAllByClass(root, 'pending-worktree');
}

function getCardToggle(card: FakeElement): FakeButtonElement {
  const toggle = card.childNodes[0];
  if (!(toggle instanceof FakeButtonElement)) {
    throw new Error('Expected card toggle button.');
  }
  return toggle;
}

function getCardOpenButton(card: FakeElement): FakeButtonElement {
  const button = findAllByClass(card, 'card-open')[0];
  if (!(button instanceof FakeButtonElement)) {
    throw new Error('Expected card open button.');
  }
  return button;
}

function getExpandedCards(list: FakeElement): FakeElement[] {
  return getCards(list).filter((card) => card.classList.contains('expanded'));
}

function getExpandedCardTitles(list: FakeElement): string[] {
  return getExpandedCards(list)
    .map((card) => findAllByClass(card, 'row-title')[0]?.textContent ?? '')
    .filter((title) => title.length > 0);
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

function getDetailRowCopyButton(section: FakeElement, label: string): FakeButtonElement {
  const button = findAllByClass(getDetailRow(section, label), 'copy-button')[0];
  if (!(button instanceof FakeButtonElement)) {
    throw new Error(`Expected copy button ${label}.`);
  }
  return button;
}

function expandRepoGroup(list: FakeElement, label: string): void {
  const header = getRepoHeader(getRepoGroupByLabel(list, label));
  if (header.getAttribute('aria-expanded') !== 'true') {
    header.click();
  }
}

function expandAllRepoGroups(list: FakeElement): void {
  for (const group of getRepoGroups(list)) {
    const header = getRepoHeader(group);
    if (header.getAttribute('aria-expanded') !== 'true') {
      header.click();
    }
  }
}

function setShowAll(elements: HarnessElements, checked: boolean): void {
  elements.showAll.checked = checked;
  elements.showAll.dispatchEvent({ type: 'change' });
}

describe('SessionDeckUI shared controller', () => {
  it('renders raw HTTP PR links, routes link/copy actions through the host, and gates diagnostics behind show-all', async () => {
    const prUrl = 'https://example.com/reviews/123';
    const harness = await setupSharedUi({
      snapshots: [
        buildSnapshot({
          diagnostics: [
            { code: 'read_error', message: 'Presence file is missing for one runtime.' },
          ],
          records: [
            buildRecord({ prUrl }),
            buildRecord({
              branch: 'staging',
              presenceState: 'dead',
              prUrl: null,
              runtimeId: 'rt-dead',
              sessionId: 'session-dead',
              sessionName: 'dead session',
            }),
          ],
        }),
      ],
    });

    expandRepoGroup(harness.elements.list, 'owner/project');
    getCardToggle(getCards(harness.elements.list)[0]!).click();

    const workspace = getDetailSection(
      getCardDetail(getExpandedCards(harness.elements.list)[0]!),
      'WORKSPACE',
    );
    const prValue = getDetailRowValue(workspace, 'PR');
    expect(prValue.getAttribute('href')).toBe(prUrl);
    prValue.click();
    expect(harness.openExternalMock).toHaveBeenCalledWith(prUrl);

    getDetailRowCopyButton(workspace, 'PR').click();
    await flushMicrotasks();
    expect(harness.copyTextMock).toHaveBeenCalledWith(prUrl);

    expect(harness.elements.diagnosticsPanel.classList.contains('hidden')).toBe(true);
    setShowAll(harness.elements, true);
    expect(harness.elements.diagnosticsPanel.classList.contains('hidden')).toBe(false);
    expect(harness.elements.diagnostics.textContent).toContain('read_error');
    expandRepoGroup(harness.elements.list, 'owner/project');
    expect(getCards(harness.elements.list)).toHaveLength(2);
  });

  it('preserves the last good snapshot when a later refresh fails', async () => {
    const loadSnapshotMock = vi
      .fn<() => Promise<unknown>>()
      .mockResolvedValueOnce(
        buildSnapshot({
          records: [
            buildRecord(),
            buildRecord({ runtimeId: 'rt-2', sessionId: 'session-2', sessionName: 'bravo' }),
          ],
        }),
      )
      .mockRejectedValueOnce(new Error('HTTP 500'));
    const harness = await setupSharedUi({ loadSnapshot: loadSnapshotMock });

    expandRepoGroup(harness.elements.list, 'owner/project');
    expect(getCards(harness.elements.list)).toHaveLength(2);

    harness.elements.refresh.click();
    await flushMicrotasks();

    expandRepoGroup(harness.elements.list, 'owner/project');
    expect(getCards(harness.elements.list)).toHaveLength(2);
    expect(harness.elements.banner.classList.contains('hidden')).toBe(false);
    expect(harness.elements.banner.textContent).toBe('HTTP 500');
  });

  it('drives the worktree composer through the shared host contract', async () => {
    const createWorktreeMock = vi.fn(async () => ({
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
        runtimeId: 'rt-created',
        message: 'Started a detached tmux Pi session.',
      },
    }));
    const harness = await setupSharedUi({
      createWorktree: createWorktreeMock,
      snapshots: [buildSnapshot(), buildSnapshot()],
    });

    getRepoActionButton(getRepoGroupByLabel(harness.elements.list, 'owner/project')).click();
    await flushMicrotasks();

    expect(harness.previewMock).toHaveBeenCalledWith({
      repoIntent: {
        repoName: 'project',
        qualifiedRepoName: 'owner/project',
        candidateRuntimeIds: ['rt-1'],
      },
    });

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

    expect(createWorktreeMock).toHaveBeenCalledWith({
      repoIntent: {
        repoName: 'project',
        qualifiedRepoName: 'owner/project',
        candidateRuntimeIds: ['rt-1'],
      },
      branchName: 'rh/feature-name',
      baseRef: 'origin/main',
      launch: { mode: 'tmux-detached', agentDir: { mode: 'ambient' } },
    });
    expect(harness.elements.list.textContent).toContain('Session launched');
    expect(harness.loadSnapshotMock).toHaveBeenCalledTimes(2);
  });

  it('reconciles the expanded selection when show-all hides the active runtime', async () => {
    const harness = await setupSharedUi({
      snapshots: [
        buildSnapshot({
          records: [
            buildRecord(),
            buildRecord({
              presenceState: 'dead',
              runtimeId: 'rt-dead',
              sessionId: 'session-dead',
              sessionName: 'staging',
            }),
          ],
        }),
      ],
    });

    setShowAll(harness.elements, true);
    expandAllRepoGroups(harness.elements.list);
    getCardToggle(getCards(harness.elements.list)[1]!).click();

    setShowAll(harness.elements, false);

    expect(getExpandedCardTitles(harness.elements.list)).toEqual(['alpha']);
  });

  it('clears Open success after the timeout fires', async () => {
    let resolveOpenRequest: ((value: unknown) => void) | undefined;
    const openTerminalMock = vi.fn(
      () =>
        new Promise<unknown>((resolve) => {
          resolveOpenRequest = resolve;
        }),
    );
    const harness = await setupSharedUi({
      openTerminal: openTerminalMock,
      snapshots: [
        buildSnapshot({
          records: [
            buildRecord(),
            buildRecord({ runtimeId: 'rt-2', sessionId: 'session-2', sessionName: 'bravo' }),
          ],
        }),
      ],
    });

    expandRepoGroup(harness.elements.list, 'owner/project');
    getCardOpenButton(getCards(harness.elements.list)[0]!).click();

    const pendingButtons = getCards(harness.elements.list).map(getCardOpenButton);
    expect(pendingButtons.map((button) => button.disabled)).toEqual([true, true]);

    resolveOpenRequest?.({ ok: true, status: 'requested', message: 'Terminal open requested.' });
    await flushMicrotasks();

    expect(getCardOpenButton(getCards(harness.elements.list)[0]!).textContent).toBe('✓');

    await harness.runTimeout(4_000);

    expect(getCardOpenButton(getCards(harness.elements.list)[0]!).textContent).toBe('↗');
    expect(getCardOpenButton(getCards(harness.elements.list)[0]!).getAttribute('data-state')).toBe(
      null,
    );
  });

  it('dismisses successful worktree feedback after the timeout fires', async () => {
    const createWorktreeMock = vi.fn(async () => ({
      ok: true,
      status: 'created',
      worktree: {
        ok: true,
        status: 'created',
        branch: 'rh/feature-name',
        baseRef: 'origin/main',
        repoName: 'project',
        qualifiedRepoName: 'owner/project',
      },
      launch: {
        requested: false,
        mode: 'tmux-detached',
        status: 'not-started',
      },
    }));
    const harness = await setupSharedUi({
      createWorktree: createWorktreeMock,
      snapshots: [buildSnapshot(), buildSnapshot()],
    });

    getRepoActionButton(getRepoGroupByLabel(harness.elements.list, 'owner/project')).click();
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

    expect(getPendingWorktreeCards(harness.elements.list)).toHaveLength(1);
    expect(harness.elements.list.textContent).toContain('Worktree ready');

    await harness.runTimeout(12_000);

    expect(getPendingWorktreeCards(harness.elements.list)).toHaveLength(0);
  });
});

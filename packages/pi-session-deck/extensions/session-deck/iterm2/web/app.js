/* global HTMLButtonElement, HTMLInputElement, document, fetch, window */

const AUTO_REFRESH_INTERVAL_MS = 15_000;
const DEFAULT_VISIBLE_STATES = new Set(['live', 'stale']);
const HOME_PREFIXES = ['/Users/', '/home/'];

const state = {
  snapshot: null,
  selectedRuntimeId: null,
  showAll: false,
  loading: false,
  fetchError: null,
};

const elements = {
  summary: document.getElementById('summary'),
  showAll: document.getElementById('show-all'),
  refresh: document.getElementById('refresh'),
  banner: document.getElementById('banner'),
  list: document.getElementById('list'),
  empty: document.getElementById('empty'),
  detail: document.getElementById('detail'),
  diagnosticsPanel: document.getElementById('diagnostics-panel'),
  diagnostics: document.getElementById('diagnostics'),
};

if (
  Object.values(elements).some((element) => element === null) ||
  !(elements.showAll instanceof HTMLInputElement) ||
  !(elements.refresh instanceof HTMLButtonElement)
) {
  throw new Error('Session Deck web UI failed to initialize.');
}

function init() {
  elements.showAll.addEventListener('change', () => {
    state.showAll = elements.showAll.checked;
    reconcileSelection();
    render();
  });

  elements.refresh.addEventListener('click', () => {
    void refreshSnapshot({ source: 'manual' });
  });

  window.setInterval(() => {
    void refreshSnapshot({ source: 'auto' });
  }, AUTO_REFRESH_INTERVAL_MS);

  void refreshSnapshot({ source: 'startup' });
}

async function refreshSnapshot({ source }) {
  state.loading = source !== 'auto';
  if (source !== 'auto') {
    state.fetchError = null;
    render();
  }

  try {
    const response = await fetch('/snapshot.json', {
      cache: 'no-store',
      headers: { Accept: 'application/json' },
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const payload = await response.json();
    state.snapshot = normalizeSnapshot(payload);
    state.fetchError = null;
    reconcileSelection();
  } catch (error) {
    state.fetchError = error instanceof Error ? error.message : String(error);
    if (source === 'startup') {
      state.snapshot = emptySnapshot(`Snapshot request failed: ${state.fetchError}`);
      reconcileSelection();
    }
  } finally {
    state.loading = false;
    render();
  }
}

function normalizeSnapshot(payload) {
  if (!isObject(payload)) {
    return emptySnapshot('Snapshot root is not an object.');
  }

  const generatedAt =
    typeof payload.generatedAt === 'string' && payload.generatedAt.length > 0
      ? payload.generatedAt
      : new Date().toISOString();
  const records = Array.isArray(payload.records)
    ? payload.records.filter(isObject).map(normalizeRecord)
    : [];
  const diagnostics = Array.isArray(payload.diagnostics)
    ? payload.diagnostics.filter(isObject).map(normalizeDiagnostic)
    : [];

  return { generatedAt, records, diagnostics };
}

function normalizeRecord(record) {
  return {
    runtimeId: typeof record.runtimeId === 'string' ? record.runtimeId : 'unknown-runtime',
    pid: typeof record.pid === 'number' ? record.pid : null,
    presenceState: normalizePresenceState(record.presenceState),
    presenceReason: typeof record.presenceReason === 'string' ? record.presenceReason : null,
    heartbeatAgeMs: typeof record.heartbeatAgeMs === 'number' ? record.heartbeatAgeMs : 0,
    sessionId: typeof record.sessionId === 'string' ? record.sessionId : null,
    sessionName: typeof record.sessionName === 'string' ? record.sessionName : null,
    repoName: typeof record.repoName === 'string' ? record.repoName : null,
    qualifiedRepoName:
      typeof record.qualifiedRepoName === 'string' ? record.qualifiedRepoName : null,
    cwd: typeof record.cwd === 'string' ? record.cwd : null,
    branch: typeof record.branch === 'string' ? record.branch : null,
    prUrl: typeof record.prUrl === 'string' ? record.prUrl : null,
    isLinkedWorktree: record.isLinkedWorktree === true,
    worktreeLabel: typeof record.worktreeLabel === 'string' ? record.worktreeLabel : null,
    derivedFacets: isObject(record.derivedFacets) ? record.derivedFacets : null,
    activityState: normalizeActivityState(record.activityState),
    activityAgeMs: typeof record.activityAgeMs === 'number' ? record.activityAgeMs : null,
    currentToolName: typeof record.currentToolName === 'string' ? record.currentToolName : null,
    lastError: typeof record.lastError === 'string' ? record.lastError : null,
    chips: Array.isArray(record.chips)
      ? record.chips.filter((chip) => typeof chip === 'string')
      : [],
    diagnostics: Array.isArray(record.diagnostics)
      ? record.diagnostics.filter(isObject).map(normalizeDiagnostic)
      : [],
  };
}

function normalizeDiagnostic(diagnostic) {
  return {
    code: typeof diagnostic.code === 'string' ? diagnostic.code : 'unknown_diagnostic',
    message: typeof diagnostic.message === 'string' ? diagnostic.message : 'Unknown diagnostic.',
    runtimeId: typeof diagnostic.runtimeId === 'string' ? diagnostic.runtimeId : null,
    filePath: typeof diagnostic.filePath === 'string' ? diagnostic.filePath : null,
  };
}

function normalizePresenceState(value) {
  return ['live', 'stale', 'dead', 'unknown'].includes(value) ? value : 'unknown';
}

function normalizeActivityState(value) {
  return ['idle', 'thinking', 'tool-running', 'error', 'unknown'].includes(value)
    ? value
    : 'unknown';
}

function emptySnapshot(message) {
  return {
    generatedAt: new Date().toISOString(),
    records: [],
    diagnostics: [
      { code: 'toolbelt_snapshot_unavailable', message, runtimeId: null, filePath: null },
    ],
  };
}

function reconcileSelection() {
  const visibleRecords = getVisibleRecords();
  if (visibleRecords.length === 0) {
    state.selectedRuntimeId = null;
    return;
  }

  if (state.selectedRuntimeId === null) {
    state.selectedRuntimeId = visibleRecords[0].runtimeId;
    return;
  }

  const stillVisible = visibleRecords.some(
    (record) => record.runtimeId === state.selectedRuntimeId,
  );
  if (!stillVisible) {
    state.selectedRuntimeId = visibleRecords[0].runtimeId;
  }
}

function getVisibleRecords() {
  const records = state.snapshot?.records ?? [];
  return state.showAll
    ? records
    : records.filter((record) => DEFAULT_VISIBLE_STATES.has(record.presenceState));
}

function render() {
  renderSummary();
  renderBanner();
  renderList();
  renderDetail();
  renderDiagnostics();
}

function renderSummary() {
  if (state.loading && state.snapshot === null) {
    elements.summary.textContent = 'Loading…';
    return;
  }

  const snapshot = state.snapshot ?? emptySnapshot('Snapshot unavailable.');
  const counts = countPresenceStates(snapshot.records);
  const parts = [`${counts.live} live`, `${counts.stale} stale`];

  if (state.showAll) {
    parts.push(`${counts.dead} dead`, `${counts.unknown} unknown`);
  }

  parts.push(`updated ${formatTimestamp(snapshot.generatedAt)}`);
  elements.summary.textContent = parts.join(' · ');
}

function renderBanner() {
  const snapshot = state.snapshot;
  const bannerMessage =
    state.fetchError ??
    getSnapshotFailureMessage(snapshot?.diagnostics ?? [], snapshot?.records.length ?? 0);

  if (!bannerMessage) {
    elements.banner.classList.add('hidden');
    elements.banner.textContent = '';
    return;
  }

  elements.banner.textContent = bannerMessage;
  elements.banner.classList.remove('hidden');
}

function renderList() {
  const visibleRecords = getVisibleRecords();
  elements.list.replaceChildren();
  elements.empty.textContent = state.showAll
    ? 'No session records found.'
    : 'No live or stale Pi sessions found.';
  elements.empty.classList.toggle('hidden', visibleRecords.length > 0);

  for (const record of visibleRecords) {
    const title = getDisplayTitle(record);
    const row = document.createElement('button');
    row.type = 'button';
    row.className = `row ${record.presenceState}`;
    row.classList.toggle('selected', record.runtimeId === state.selectedRuntimeId);
    row.addEventListener('click', () => {
      state.selectedRuntimeId = record.runtimeId;
      render();
    });

    row.append(
      createLine('row-line1', [
        createText('span', getPresenceIcon(record.presenceState), 'status-icon'),
        createText('span', formatActivitySummary(record), 'muted'),
        createText('span', title.text, 'row-title'),
      ]),
      createLine(
        'row-line2',
        [
          getRepoLabel(record, title.source),
          formatPr(record.prUrl),
          formatDuration(getListAgeMs(record)),
          record.branch,
        ]
          .filter((value) => typeof value === 'string' && value.length > 0)
          .map((value) => createText('span', value, 'muted')),
      ),
    );

    if (record.chips.length > 0) {
      const chips = document.createElement('div');
      chips.className = 'chips chips-inline';
      for (const chip of record.chips) {
        chips.append(createChip(chip));
      }
      row.append(chips);
    }

    elements.list.append(row);
  }
}

function renderDetail() {
  const record = getVisibleRecords().find(
    (candidate) => candidate.runtimeId === state.selectedRuntimeId,
  );
  if (!record) {
    elements.detail.className = 'detail muted';
    elements.detail.replaceChildren(document.createTextNode('Select a session.'));
    return;
  }

  const detail = document.createElement('div');
  detail.className = 'detail';

  const header = document.createElement('div');
  header.append(
    createText('div', getDisplayTitle(record).text, 'detail-title'),
    createText(
      'div',
      [record.qualifiedRepoName ?? record.repoName, formatPr(record.prUrl)]
        .filter(Boolean)
        .join(' · ') || 'Session details',
      'summary-line',
    ),
  );
  detail.append(header);

  detail.append(
    createText('div', formatStatusLine(record), 'summary-line'),
    createMetaGrid(record),
  );

  if (record.chips.length > 0) {
    const chipSection = document.createElement('section');
    chipSection.className = 'detail-section';
    chipSection.append(createText('div', 'Chips', 'detail-section-title'));

    const chips = document.createElement('div');
    chips.className = 'chips';
    for (const chip of record.chips) {
      chips.append(createChip(chip));
    }
    chipSection.append(chips);
    detail.append(chipSection);
  }

  if (record.derivedFacets && Object.keys(record.derivedFacets).length > 0) {
    const facetsSection = document.createElement('section');
    facetsSection.className = 'detail-section';
    facetsSection.append(createText('div', 'Derived facets', 'detail-section-title'));

    const facets = document.createElement('div');
    facets.className = 'chips';
    for (const [key, value] of Object.entries(record.derivedFacets)) {
      if (typeof value === 'string' && value.length > 0) {
        facets.append(createChip(`${humanizeKey(key)}: ${value}`));
      }
    }

    if (facets.childNodes.length > 0) {
      facetsSection.append(facets);
      detail.append(facetsSection);
    }
  }

  if (record.diagnostics.length > 0) {
    const diagnosticsSection = document.createElement('section');
    diagnosticsSection.className = 'detail-section';
    diagnosticsSection.append(createText('div', 'Record diagnostics', 'detail-section-title'));

    const list = document.createElement('ul');
    list.className = 'diagnostics';
    for (const diagnostic of record.diagnostics) {
      list.append(createDiagnosticItem(diagnostic));
    }
    diagnosticsSection.append(list);
    detail.append(diagnosticsSection);
  }

  elements.detail.className = 'detail';
  elements.detail.replaceChildren(detail);
}

function createMetaGrid(record) {
  const grid = document.createElement('div');
  grid.className = 'meta-grid';

  const items = [
    ['Session ID', record.sessionId],
    ['Runtime ID', record.runtimeId],
    ['PID', record.pid === null ? null : String(record.pid)],
    ['CWD', record.cwd === null ? null : shortenHomePath(record.cwd)],
    ['Branch', record.branch],
    ['PR', formatPr(record.prUrl)],
    ['Repo', record.qualifiedRepoName ?? record.repoName],
    ['Checkout', formatCheckout(record)],
    ['Current tool', record.currentToolName],
    ['Last error', record.lastError],
    ['Presence reason', humanizePresenceReason(record.presenceReason)],
    ['Activity age', record.activityAgeMs === null ? null : formatDuration(record.activityAgeMs)],
    ['Heartbeat age', formatDuration(record.heartbeatAgeMs)],
  ];

  for (const [label, value] of items) {
    if (value === null || value === '') {
      continue;
    }

    const card = document.createElement('div');
    card.className = 'meta-card';
    card.append(createText('div', label, 'meta-label'), createText('div', value, 'meta-value'));
    grid.append(card);
  }

  return grid;
}

function renderDiagnostics() {
  const diagnostics = state.showAll ? (state.snapshot?.diagnostics ?? []) : [];
  elements.diagnostics.replaceChildren();
  elements.diagnosticsPanel.classList.toggle('hidden', diagnostics.length === 0);

  for (const diagnostic of diagnostics) {
    elements.diagnostics.append(createDiagnosticItem(diagnostic));
  }
}

function createDiagnosticItem(diagnostic) {
  const item = document.createElement('li');
  item.className = 'diag-line';
  item.textContent = formatDiagnostic(diagnostic);
  return item;
}

function countPresenceStates(records) {
  return records.reduce(
    (counts, record) => {
      counts[record.presenceState] += 1;
      return counts;
    },
    { live: 0, stale: 0, dead: 0, unknown: 0 },
  );
}

function getDisplayTitle(record) {
  if (record.sessionName) {
    return { text: record.sessionName, source: 'sessionName' };
  }
  if (record.repoName) {
    return { text: record.repoName, source: 'repoName' };
  }

  const cwdBasename = getCwdBasename(record.cwd);
  if (cwdBasename) {
    return { text: cwdBasename, source: 'cwd' };
  }

  return { text: formatShortId(record.runtimeId), source: 'runtimeId' };
}

function getRepoLabel(record, titleSource) {
  if (titleSource === 'repoName' || titleSource === 'cwd') {
    return null;
  }
  return record.repoName ?? getCwdBasename(record.cwd);
}

function getCwdBasename(cwd) {
  if (!cwd) {
    return null;
  }
  const normalized = cwd.replace(/\/+$/u, '');
  if (normalized.length === 0) {
    return shortenHomePath(cwd);
  }
  const parts = normalized.split('/');
  return parts[parts.length - 1] || shortenHomePath(cwd);
}

function formatCheckout(record) {
  if (!record.isLinkedWorktree) {
    return null;
  }
  return record.worktreeLabel ? `worktree · ${record.worktreeLabel}` : 'worktree';
}

function formatPr(prUrl) {
  if (!prUrl) {
    return null;
  }
  const match = prUrl.match(/\/pull\/(\d+)$/u);
  return match ? `#${match[1]}` : prUrl;
}

function formatStatusLine(record) {
  return [
    `presence: ${getPresenceIcon(record.presenceState)} ${record.presenceState}`,
    `activity: ${formatSelectedActivity(record)}`,
    `heartbeat: ${formatDuration(record.heartbeatAgeMs)} ago${formatPresenceReasonSuffix(record)}`,
  ].join(' · ');
}

function formatSelectedActivity(record) {
  const activity = getActivityDisplay(record);
  const lead = activity.detail ? `${activity.label}: ${activity.detail}` : activity.label;
  return [lead, activity.cardAgeLabel].filter(Boolean).join(' · ');
}

function formatActivitySummary(record) {
  const activity = getActivityDisplay(record);
  const lead = activity.detail ? `${activity.label}: ${activity.detail}` : activity.label;
  return [lead, activity.summaryAgeLabel].filter(Boolean).join(' ');
}

function getActivityDisplay(record) {
  const ageLabel = record.activityAgeMs === null ? null : formatDuration(record.activityAgeMs);

  switch (record.activityState) {
    case 'idle':
      return { label: 'idle', detail: null, cardAgeLabel: null, summaryAgeLabel: null };
    case 'thinking':
      return { label: 'thinking', detail: null, cardAgeLabel: ageLabel, summaryAgeLabel: ageLabel };
    case 'tool-running':
      return {
        label: 'tool-running',
        detail: record.currentToolName,
        cardAgeLabel: ageLabel,
        summaryAgeLabel: ageLabel,
      };
    case 'error':
      return {
        label: 'error',
        detail: record.lastError,
        cardAgeLabel: ageLabel,
        summaryAgeLabel: null,
      };
    default:
      return {
        label: record.activityState,
        detail: null,
        cardAgeLabel: ageLabel,
        summaryAgeLabel: null,
      };
  }
}

function getListAgeMs(record) {
  return record.presenceState === 'stale' || record.presenceState === 'dead'
    ? record.heartbeatAgeMs
    : (record.activityAgeMs ?? record.heartbeatAgeMs);
}

function formatDuration(durationMs) {
  if (!Number.isFinite(durationMs) || durationMs < 0) {
    return 'n/a';
  }
  if (durationMs < 1_000) {
    return `${durationMs}ms`;
  }
  if (durationMs < 60_000) {
    return `${Math.round(durationMs / 1_000)}s`;
  }
  if (durationMs < 60 * 60_000) {
    return `${Math.round(durationMs / 60_000)}m`;
  }
  return `${Math.round(durationMs / (60 * 60_000))}h`;
}

function formatTimestamp(isoString) {
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) {
    return isoString;
  }
  return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
}

function getPresenceIcon(stateName) {
  switch (stateName) {
    case 'live':
      return '●';
    case 'stale':
      return '◌';
    case 'dead':
      return '×';
    default:
      return '◇';
  }
}

function formatPresenceReasonSuffix(record) {
  const reason = humanizePresenceReason(record.presenceReason);
  return reason === null ? '' : ` · ${reason}`;
}

function humanizePresenceReason(reason) {
  if (!reason || reason === 'fresh_heartbeat') {
    return null;
  }

  return reason.replaceAll('_', ' ');
}

function formatDiagnostic(diagnostic) {
  const location = diagnostic.runtimeId
    ? ` runtime=${diagnostic.runtimeId}`
    : diagnostic.filePath
      ? ` (${diagnostic.filePath})`
      : '';
  return `${diagnostic.code}${location}: ${diagnostic.message}`;
}

function getSnapshotFailureMessage(diagnostics, recordCount) {
  if (state.loading) {
    return null;
  }

  const toolbeltDiagnostic = diagnostics.find(
    (diagnostic) => diagnostic.code === 'toolbelt_snapshot_unavailable',
  );
  if (recordCount > 0) {
    return toolbeltDiagnostic?.message ?? null;
  }

  return toolbeltDiagnostic?.message ?? diagnostics[0]?.message ?? null;
}

function formatShortId(value) {
  return value.length <= 8 ? value : value.slice(0, 8);
}

function shortenHomePath(cwd) {
  const homeDirectory = detectHomeDirectory();
  if (homeDirectory && cwd.startsWith(homeDirectory)) {
    return `~${cwd.slice(homeDirectory.length)}`;
  }
  return cwd;
}

function detectHomeDirectory() {
  const cwd = state.snapshot?.records.find((record) => record.cwd)?.cwd;
  if (!cwd || !HOME_PREFIXES.some((prefix) => cwd.startsWith(prefix))) {
    return null;
  }

  const segments = cwd.split('/');
  return segments.length >= 4 ? segments.slice(0, 3).join('/') : null;
}

function humanizeKey(value) {
  return value
    .replace(/[A-Z]/gu, (match) => ` ${match.toLowerCase()}`)
    .replace(/^./u, (match) => match.toUpperCase());
}

function createLine(className, children) {
  const line = document.createElement('div');
  line.className = className;
  line.append(...children);
  return line;
}

function createText(tagName, text, className) {
  const element = document.createElement(tagName);
  if (className) {
    element.className = className;
  }
  element.textContent = text;
  return element;
}

function createChip(text) {
  return createText('span', text, 'chip');
}

function isObject(candidate) {
  return typeof candidate === 'object' && candidate !== null;
}

init();

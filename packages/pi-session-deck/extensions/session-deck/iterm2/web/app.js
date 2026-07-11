/* global HTMLButtonElement, HTMLInputElement, document, fetch, navigator, window */

const AUTO_REFRESH_INTERVAL_MS = 15_000;
const DEFAULT_VISIBLE_STATES = new Set(['live', 'stale']);
const HOME_PREFIXES = ['/Users/', '/home/'];

const state = {
  snapshot: null,
  selectedRuntimeId: null,
  detailVisible: false,
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

  const stillVisible =
    state.selectedRuntimeId !== null &&
    visibleRecords.some((record) => record.runtimeId === state.selectedRuntimeId);

  if (!state.detailVisible) {
    if (!stillVisible) {
      state.selectedRuntimeId = null;
    }
    return;
  }

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
    const isExpanded = state.detailVisible && record.runtimeId === state.selectedRuntimeId;
    const title = getDisplayTitle(record);
    const card = document.createElement('article');
    card.className = `card ${record.presenceState}`;
    card.classList.toggle('expanded', isExpanded);
    card.setAttribute('role', 'listitem');

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'card-toggle';
    toggle.setAttribute('aria-expanded', String(isExpanded));
    toggle.addEventListener('click', () => {
      if (isExpanded) {
        state.detailVisible = false;
      } else {
        state.selectedRuntimeId = record.runtimeId;
        state.detailVisible = true;
      }
      render();
    });

    toggle.append(
      createLine('row-line1', [
        createText('span', getPresenceIcon(record.presenceState), 'status-icon'),
        createText('span', formatActivitySummary(record), 'muted'),
        createText('span', title.text, 'row-title'),
        createText('span', formatDuration(getListAgeMs(record)), 'muted row-age'),
      ]),
      createLine(
        'row-line2',
        [getRepoLabel(record, title.source), formatPr(record.prUrl), record.branch]
          .filter((value) => typeof value === 'string' && value.length > 0)
          .map((value) => createText('span', value, 'muted')),
      ),
    );

    if (record.chips.length > 0 && !isExpanded) {
      const chips = document.createElement('div');
      chips.className = 'chips chips-inline';
      for (const chip of record.chips) {
        chips.append(createChip(chip));
      }
      toggle.append(chips);
    }

    card.append(toggle);
    if (isExpanded) {
      card.append(createRecordDetail(record));
    }

    elements.list.append(card);
  }
}

function createRecordDetail(record) {
  const detail = document.createElement('div');
  detail.className = 'detail card-detail';

  const workspaceRepo = record.qualifiedRepoName ?? record.repoName;
  const workspacePr = formatPr(record.prUrl);
  const checkout = formatCheckout(record);

  detail.append(
    createDetailSection('IDENTITY', [
      createDetailRow('Session ID', record.sessionId, {
        copyLabel: 'Session ID',
        copyValue: record.sessionId,
      }),
      createDetailRow('Runtime ID', record.runtimeId, {
        copyLabel: 'Runtime ID',
        copyValue: record.runtimeId,
      }),
      createDetailRow('PID', record.pid === null ? null : String(record.pid), {
        copyLabel: 'PID',
        copyValue: record.pid === null ? null : String(record.pid),
      }),
    ]),
    createDetailSection('WORKSPACE', [
      createDetailRow('CWD', record.cwd === null ? null : shortenHomePath(record.cwd), {
        copyLabel: 'CWD',
        copyValue: record.cwd,
      }),
      createDetailRow('Branch', record.branch, {
        copyLabel: 'Branch',
        copyValue: record.branch,
      }),
      createDetailRow('Repo', workspaceRepo, {
        copyLabel: 'Repo',
        copyValue: workspaceRepo,
      }),
      createDetailRow('Checkout', checkout, {
        copyLabel: 'Checkout',
        copyValue: checkout,
      }),
      createDetailRow('PR', workspacePr, {
        copyLabel: 'PR',
        copyValue: record.prUrl ?? workspacePr,
      }),
    ]),
    createStatusSection(record),
  );

  if (record.diagnostics.length > 0) {
    const list = document.createElement('ul');
    list.className = 'detail-diagnostics';
    for (const diagnostic of record.diagnostics) {
      list.append(createDiagnosticItem(diagnostic));
    }
    detail.append(createDetailSection('Record diagnostics', [list]));
  }

  return detail;
}

function createStatusSection(record) {
  const content = [];

  if (record.chips.length > 0) {
    const chips = document.createElement('div');
    chips.className = 'chips detail-chips';
    for (const chip of record.chips) {
      chips.append(createChip(chip));
    }
    content.push(chips);
  }

  content.push(
    createDetailRow('Presence reason', humanizePresenceReason(record.presenceReason)),
    createDetailRow('Current tool', record.currentToolName),
    createDetailRow('Last error', record.lastError),
  );

  return createDetailSection('STATUS', content);
}

function createDetailSection(title, children) {
  const section = document.createElement('section');
  section.className = 'detail-section';
  section.append(createText('div', title, 'detail-section-title'));

  const body = document.createElement('div');
  body.className = 'detail-section-body';
  for (const child of children) {
    if (child) {
      body.append(child);
    }
  }

  section.append(body);
  return section;
}

function createDetailRow(label, value, options = {}) {
  if (value === null || value === '') {
    return null;
  }

  const row = document.createElement('div');
  row.className = 'detail-row';
  row.append(createText('div', label, 'detail-label'), createText('div', value, 'detail-value'));

  const copyButton = createCopyButton(options.copyLabel ?? label, options.copyValue ?? value);
  if (copyButton) {
    row.append(copyButton);
  }

  return row;
}

function createCopyButton(label, value) {
  if (value === null || value === '') {
    return null;
  }

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'copy-button';
  button.setAttribute('aria-label', `Copy ${label}`);
  button.setAttribute('title', 'copy');
  button.textContent = '⧉';
  button.addEventListener('click', () => {
    copyTextToClipboard(value);
  });
  return button;
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
    return 'primary';
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

function formatActivitySummary(record) {
  const activity = getActivityDisplay(record);
  return activity.detail ? `${activity.label}: ${activity.detail}` : activity.label;
}

function getActivityDisplay(record) {
  const ageLabel = record.activityAgeMs === null ? null : formatDuration(record.activityAgeMs);

  switch (record.activityState) {
    case 'idle':
      return { label: 'idle', detail: null, cardAgeLabel: null };
    case 'thinking':
      return { label: 'thinking', detail: null, cardAgeLabel: ageLabel };
    case 'tool-running':
      return {
        label: 'tool-running',
        detail: record.currentToolName,
        cardAgeLabel: ageLabel,
      };
    case 'error':
      return {
        label: 'error',
        detail: record.lastError,
        cardAgeLabel: ageLabel,
      };
    default:
      return {
        label: record.activityState,
        detail: null,
        cardAgeLabel: ageLabel,
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

function copyTextToClipboard(text) {
  if (typeof navigator === 'undefined' || typeof navigator.clipboard?.writeText !== 'function') {
    return;
  }

  void navigator.clipboard.writeText(text).catch(() => {});
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

function createChip(text, className = 'chip') {
  return createText('span', text, className);
}

function isObject(candidate) {
  return typeof candidate === 'object' && candidate !== null;
}

init();

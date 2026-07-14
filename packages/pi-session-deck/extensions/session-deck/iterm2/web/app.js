/* global HTMLButtonElement, HTMLInputElement, URL, document, fetch, navigator, window */

const AUTO_REFRESH_INTERVAL_MS = 15_000;
const COLLAPSED_CHIP_LIMIT = 2;
const DEFAULT_VISIBLE_STATES = new Set(['live', 'stale']);
const HOME_PREFIXES = ['/Users/', '/home/'];
const NO_REPO_GROUP_KEY = 'no-repo';
const NO_REPO_LABEL = 'No repo';

const state = {
  snapshot: null,
  selectedRuntimeId: null,
  detailVisible: false,
  showAll: false,
  loading: false,
  fetchError: null,
  expandedRepoKeys: new Set(),
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
    reconcileExpandedRepoKeys();
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
    reconcileExpandedRepoKeys();
  } catch (error) {
    state.fetchError = error instanceof Error ? error.message : String(error);
    if (source === 'startup') {
      state.snapshot = emptySnapshot(`Snapshot request failed: ${state.fetchError}`);
      reconcileSelection();
      reconcileExpandedRepoKeys();
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

  if (!isSessionDeckSnapshot(payload)) {
    return emptySnapshot('Snapshot payload does not match SessionDeckSnapshot.');
  }

  return payload;
}

function isSessionDeckSnapshot(candidate) {
  return (
    typeof candidate.generatedAt === 'string' &&
    Array.isArray(candidate.records) &&
    candidate.records.every(isSessionDeckRecord) &&
    Array.isArray(candidate.diagnostics) &&
    candidate.diagnostics.every(isSessionDeckDiagnostic)
  );
}

function isSessionDeckRecord(candidate) {
  return (
    isObject(candidate) &&
    typeof candidate.runtimeId === 'string' &&
    isNullableNumber(candidate.pid) &&
    isPresenceState(candidate.presenceState) &&
    isOptionalString(candidate.presenceReason) &&
    typeof candidate.heartbeatAgeMs === 'number' &&
    isNullableString(candidate.sessionId) &&
    isNullableString(candidate.sessionName) &&
    isNullableString(candidate.repoName) &&
    isNullableString(candidate.qualifiedRepoName) &&
    isNullableString(candidate.cwd) &&
    isNullableString(candidate.branch) &&
    isNullableString(candidate.prUrl) &&
    isNullableBoolean(candidate.isLinkedWorktree) &&
    isNullableString(candidate.worktreeLabel) &&
    isActivityState(candidate.activityState) &&
    isNullableNumber(candidate.activityAgeMs) &&
    isNullableString(candidate.currentToolName) &&
    isNullableString(candidate.lastError) &&
    Array.isArray(candidate.chips) &&
    candidate.chips.every((chip) => typeof chip === 'string') &&
    Array.isArray(candidate.diagnostics) &&
    candidate.diagnostics.every(isSessionDeckDiagnostic)
  );
}

function isSessionDeckDiagnostic(candidate) {
  return (
    isObject(candidate) &&
    typeof candidate.code === 'string' &&
    typeof candidate.message === 'string' &&
    isOptionalString(candidate.runtimeId) &&
    isOptionalString(candidate.filePath)
  );
}

function isPresenceState(value) {
  return ['live', 'stale', 'dead', 'unknown'].includes(value);
}

function isActivityState(value) {
  return ['idle', 'thinking', 'tool-running', 'error', 'unknown'].includes(value);
}

function isNullableString(value) {
  return typeof value === 'string' || value === null;
}

function isOptionalString(value) {
  return value === undefined || typeof value === 'string';
}

function isNullableNumber(value) {
  return typeof value === 'number' || value === null;
}

function isNullableBoolean(value) {
  return typeof value === 'boolean' || value === null;
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

function reconcileExpandedRepoKeys(repoGroups = createRepoGroups(getVisibleRecords())) {
  const visibleRepoKeys = new Set(repoGroups.map((repoGroup) => repoGroup.key));
  for (const expandedRepoKey of state.expandedRepoKeys) {
    if (!visibleRepoKeys.has(expandedRepoKey)) {
      state.expandedRepoKeys.delete(expandedRepoKey);
    }
  }
}

function createRepoGroups(records) {
  const qualifiedGroups = new Map();
  const qualifiedKeysByShortName = new Map();

  for (const record of records) {
    const qualifiedRepoName = getRepoIdentityValue(record.qualifiedRepoName);
    if (!qualifiedRepoName) {
      continue;
    }

    const key = getQualifiedRepoKey(qualifiedRepoName);
    if (!qualifiedGroups.has(key)) {
      const repoGroup = {
        key,
        label: qualifiedRepoName,
        kind: 'qualified',
        records: [],
      };
      qualifiedGroups.set(key, repoGroup);

      const shortName = getRepoShortName(qualifiedRepoName);
      const matchingKeys = qualifiedKeysByShortName.get(shortName) ?? new Set();
      matchingKeys.add(key);
      qualifiedKeysByShortName.set(shortName, matchingKeys);
    }
  }

  const unqualifiedTargets = new Map();
  for (const record of records) {
    if (getRepoIdentityValue(record.qualifiedRepoName)) {
      continue;
    }

    const repoName = getRepoIdentityValue(record.repoName);
    if (!repoName || unqualifiedTargets.has(repoName)) {
      continue;
    }

    const matchingQualifiedKeys = qualifiedKeysByShortName.get(repoName);
    unqualifiedTargets.set(
      repoName,
      matchingQualifiedKeys?.size === 1
        ? matchingQualifiedKeys.values().next().value
        : getUnqualifiedRepoKey(repoName),
    );
  }

  const groupsByKey = new Map();
  for (const record of records) {
    const qualifiedRepoName = getRepoIdentityValue(record.qualifiedRepoName);
    if (qualifiedRepoName) {
      getOrCreateRepoGroup(
        groupsByKey,
        getQualifiedRepoKey(qualifiedRepoName),
        qualifiedRepoName,
        'qualified',
      ).records.push(record);
      continue;
    }

    const repoName = getRepoIdentityValue(record.repoName);
    if (repoName) {
      const targetKey = unqualifiedTargets.get(repoName) ?? getUnqualifiedRepoKey(repoName);
      const qualifiedGroup = qualifiedGroups.get(targetKey);
      getOrCreateRepoGroup(
        groupsByKey,
        targetKey,
        qualifiedGroup?.label ?? repoName,
        qualifiedGroup?.kind ?? 'repo',
      ).records.push(record);
      continue;
    }

    getOrCreateRepoGroup(groupsByKey, NO_REPO_GROUP_KEY, NO_REPO_LABEL, 'no-repo').records.push(
      record,
    );
  }

  return [...groupsByKey.values()].sort(compareRepoGroups);
}

function getOrCreateRepoGroup(groupsByKey, key, label, kind) {
  const existingGroup = groupsByKey.get(key);
  if (existingGroup) {
    return existingGroup;
  }

  const repoGroup = { key, label, kind, records: [] };
  groupsByKey.set(key, repoGroup);
  return repoGroup;
}

function compareRepoGroups(left, right) {
  if (left.kind === 'no-repo' || right.kind === 'no-repo') {
    return left.kind === right.kind ? 0 : left.kind === 'no-repo' ? 1 : -1;
  }

  const leftLabel = left.label.toLowerCase();
  const rightLabel = right.label.toLowerCase();
  const labelOrder = leftLabel.localeCompare(rightLabel);
  return labelOrder === 0 ? left.key.localeCompare(right.key) : labelOrder;
}

function getRepoIdentityValue(value) {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function getQualifiedRepoKey(qualifiedRepoName) {
  return `qualified:${qualifiedRepoName}`;
}

function getUnqualifiedRepoKey(repoName) {
  return `repo:${repoName}`;
}

function getRepoShortName(qualifiedRepoName) {
  const parts = qualifiedRepoName.split('/');
  return parts[parts.length - 1] || qualifiedRepoName;
}

function getRepoGroupRecordsId(repoGroupKey) {
  const encodedKey = [];
  for (let index = 0; index < repoGroupKey.length; index += 1) {
    encodedKey.push(repoGroupKey.charCodeAt(index).toString(16).padStart(4, '0'));
  }
  return `repo-group-records-${encodedKey.join('-')}`;
}

function formatRepoHeader(repoGroup) {
  return `${repoGroup.label} · ${repoGroup.records.length}`;
}

function getRepoLabelParts(label) {
  const separatorIndex = label.lastIndexOf('/');
  if (separatorIndex <= 0 || separatorIndex === label.length - 1) {
    return { owner: null, name: label };
  }

  return {
    owner: label.slice(0, separatorIndex),
    name: label.slice(separatorIndex + 1),
  };
}

function createRepoHeaderLabel(repoGroup) {
  const label = document.createElement('span');
  const labelParts = getRepoLabelParts(repoGroup.label);
  label.className = 'repo-header-label';

  if (repoGroup.kind === 'no-repo') {
    label.append(createText('span', repoGroup.label));
  } else if (labelParts.owner) {
    label.append(
      createText('span', labelParts.owner, 'repo-owner'),
      createText('span', '/', 'repo-owner repo-separator'),
      createText('span', labelParts.name, 'repo-name'),
    );
  } else {
    label.append(createText('span', repoGroup.label, 'repo-name'));
  }

  label.append(
    createText('span', ' · ', 'repo-divider'),
    createText('span', String(repoGroup.records.length), 'repo-count'),
  );

  return label;
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
  const summaryLabels = [`${counts.live} live`];

  if (counts.stale > 0) {
    summaryLabels.push(`${counts.stale} stale`);
  }

  if (state.showAll) {
    if (counts.dead > 0) {
      summaryLabels.push(`${counts.dead} dead`);
    }
    if (counts.unknown > 0) {
      summaryLabels.push(`${counts.unknown} unknown`);
    }
  }

  elements.summary.replaceChildren(
    ...summaryLabels.map((label) => createText('span', label, 'summary-count')),
    createText('span', `updated ${formatTimestamp(snapshot.generatedAt)}`, 'summary-meta'),
  );
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
  const repoGroups = createRepoGroups(visibleRecords);
  reconcileExpandedRepoKeys(repoGroups);
  elements.list.replaceChildren();
  elements.empty.textContent = state.showAll
    ? 'No session records found.'
    : 'No live or stale Pi sessions found.';
  elements.empty.classList.toggle('hidden', visibleRecords.length > 0);

  for (const repoGroup of repoGroups) {
    elements.list.append(createRepoGroup(repoGroup));
  }
}

function createRepoGroup(repoGroup) {
  const isExpanded = state.expandedRepoKeys.has(repoGroup.key);
  const section = document.createElement('section');
  section.className = 'repo-group';
  section.setAttribute('role', 'listitem');

  const header = document.createElement('button');
  header.type = 'button';
  header.className = 'repo-header';
  header.setAttribute('aria-expanded', String(isExpanded));
  header.setAttribute('aria-label', formatRepoHeader(repoGroup));
  header.append(createRepoHeaderLabel(repoGroup));
  header.addEventListener('click', () => {
    if (isExpanded) {
      state.expandedRepoKeys.delete(repoGroup.key);
    } else {
      state.expandedRepoKeys.add(repoGroup.key);
    }
    render();
  });

  section.append(header);

  if (isExpanded) {
    const records = document.createElement('div');
    const recordsId = getRepoGroupRecordsId(repoGroup.key);
    records.className = 'repo-group-records';
    records.setAttribute('id', recordsId);
    records.setAttribute('role', 'list');
    records.setAttribute('aria-label', `${repoGroup.label} sessions`);
    header.setAttribute('aria-controls', recordsId);

    for (const record of repoGroup.records) {
      records.append(createRecordCard(record));
    }
    section.append(records);
  }

  return section;
}

function createRecordCard(record) {
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
      createActivityIcon(record),
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
    for (const chip of record.chips.slice(0, COLLAPSED_CHIP_LIMIT)) {
      chips.append(createChip(chip));
    }
    const hiddenChipCount = record.chips.length - COLLAPSED_CHIP_LIMIT;
    if (hiddenChipCount > 0) {
      chips.append(createChip(`+${hiddenChipCount}`, 'chip chip-subtle'));
    }
    toggle.append(chips);
  }

  card.append(toggle);
  if (isExpanded) {
    card.append(createRecordDetail(record));
  }

  return card;
}

function createRecordDetail(record) {
  const detail = document.createElement('div');
  detail.className = 'detail card-detail';

  const workspaceRepo = record.qualifiedRepoName ?? record.repoName;
  const workspacePr = formatPr(record.prUrl);
  const workspacePrHref = getPullRequestHref(record);
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
        copyValue: workspacePrHref ?? workspacePr,
        linkHref: workspacePrHref,
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
  row.append(
    createText('div', label, 'detail-label'),
    createDetailValue(value, options.linkHref ?? null),
  );

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
  const prNumber = parsePullRequestNumber(prUrl);
  return prNumber ? `#${prNumber}` : prUrl;
}

function getPullRequestHref(record) {
  const prNumber = parsePullRequestNumber(record.prUrl);
  if (prNumber !== null) {
    const qualifiedRepoName = getQualifiedRepoName(record);
    if (qualifiedRepoName !== null) {
      return `https://github.com/${qualifiedRepoName}/pull/${prNumber}`;
    }
  }

  return isHttpUrl(record.prUrl) ? record.prUrl : null;
}

function getQualifiedRepoName(record) {
  const repoName = record.qualifiedRepoName ?? record.repoName;
  return repoName && repoName.includes('/') ? repoName : null;
}

function parsePullRequestNumber(prUrl) {
  if (!prUrl) {
    return null;
  }
  const match = prUrl.match(/\/pull\/(\d+)$/u);
  return match ? match[1] : null;
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
    return '<1s';
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
  return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function createActivityIcon(record) {
  const activity = getActivityDisplay(record);
  const label = activity.detail ? `${activity.label}: ${activity.detail}` : activity.label;
  const icon = document.createElement('span');
  icon.className = 'activity-icon';
  icon.setAttribute('data-activity', record.activityState);
  icon.setAttribute('role', 'img');
  icon.setAttribute('aria-label', label);
  icon.setAttribute('title', label);

  const svg = createSvgElement('svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', '16');
  svg.setAttribute('height', '16');
  svg.setAttribute('aria-hidden', 'true');

  switch (record.activityState) {
    case 'idle':
      svg.append(createSvgCircle({ cx: '8', cy: '8', r: '5.5' }));
      break;
    case 'thinking': {
      const orbit = createSvgCircle({ cx: '8', cy: '8', r: '6.35' });
      orbit.setAttribute('class', 'activity-icon-thinking-orbit');
      orbit.setAttribute('stroke-linecap', 'round');
      orbit.setAttribute('stroke-width', '1.2');
      svg.append(
        createSvgPath(
          'M9.5 2A2.5 2.5 0 0 1 12 4.5v.2A2.5 2.5 0 0 1 14 7.1c0 .8-.4 1.5-1 2 .6.5 1 1.2 1 2A2.9 2.9 0 0 1 11.1 14H10a2 2 0 0 1-2-2V4a2 2 0 0 1 1.5-2ZM6.5 2A2.5 2.5 0 0 0 4 4.5v.2A2.5 2.5 0 0 0 2 7.1c0 .8.4 1.5 1 2-.6.5-1 1.2-1 2A2.9 2.9 0 0 0 4.9 14H6a2 2 0 0 0 2-2V4a2 2 0 0 0-1.5-2Z',
        ),
        orbit,
      );
      break;
    }
    case 'tool-running':
      svg.append(
        createSvgPath(
          'M.1 2.2A3 3 0 0 0 3.8 5.9l6.3 6.3a3 3 0 0 0 3.7 3.7l-2.1-2.1a.5.5 0 0 1 .4-.9h1.4a.5.5 0 0 1 .4.1l2.1 2.1a3 3 0 0 0-3.7-3.7L5.9 5.1A3 3 0 0 0 2.2.1l2.1 2.1a.5.5 0 0 1-.4.9H2.5a.5.5 0 0 1-.4-.1L.1 2.2Z',
        ),
      );
      break;
    case 'error':
      svg.append(
        createSvgPath(
          'M8.9 1.5l6.4 11c.3.5.1 1.1-.4 1.4-.2.1-.3.1-.5.1H1.6c-.6 0-1-.4-1-1 0-.2 0-.3.1-.5l6.4-11c.3-.5.9-.6 1.4-.4.2.2.4.3.4.4zM8 11c-.6 0-1 .4-1 1s.4 1 1 1 1-.4 1-1-.4-1-1-1zm0-6c-.6 0-1 .4-1 1v3c0 .6.4 1 1 1s1-.4 1-1V6c0-.6-.4-1-1-1z',
        ),
      );
      break;
    default:
      svg.append(createSvgCircle({ cx: '8', cy: '8', r: '6.5' }));
      svg.append(createSvgText('?'));
      break;
  }

  icon.append(svg);
  return icon;
}

function createSvgElement(tagName) {
  return document.createElementNS('http://www.w3.org/2000/svg', tagName);
}

function createSvgPath(pathData) {
  const path = createSvgElement('path');
  path.setAttribute('d', pathData);
  path.setAttribute('fill', 'currentColor');
  return path;
}

function createSvgCircle(attributes) {
  const circle = createSvgElement('circle');
  for (const [name, value] of Object.entries(attributes)) {
    circle.setAttribute(name, value);
  }
  circle.setAttribute('fill', 'none');
  circle.setAttribute('stroke', 'currentColor');
  circle.setAttribute('stroke-width', '1.5');
  return circle;
}

function createSvgText(textValue) {
  const text = createSvgElement('text');
  text.setAttribute('x', '8');
  text.setAttribute('y', '11');
  text.setAttribute('fill', 'currentColor');
  text.setAttribute('text-anchor', 'middle');
  text.setAttribute('font-size', '10');
  text.setAttribute('font-weight', '700');
  text.textContent = textValue;
  return text;
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

function isHttpUrl(value) {
  if (!value) {
    return false;
  }

  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
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

function createDetailValue(text, linkHref) {
  if (linkHref) {
    const link = createText('a', text, 'detail-value detail-link');
    link.setAttribute('href', linkHref);
    link.setAttribute('target', '_blank');
    link.setAttribute('rel', 'noreferrer');
    link.addEventListener('click', (event) => {
      event.preventDefault();
      window.open(linkHref, '_blank', 'noopener,noreferrer');
    });
    return link;
  }

  return createText('div', text, 'detail-value');
}

function createChip(text, className = 'chip') {
  return createText('span', text, className);
}

function isObject(candidate) {
  return typeof candidate === 'object' && candidate !== null;
}

init();

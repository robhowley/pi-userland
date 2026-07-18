/* global HTMLButtonElement, HTMLInputElement, URL, document, fetch, navigator, window */

const AUTO_REFRESH_INTERVAL_MS = 15_000;
const COLLAPSED_CHIP_LIMIT = 2;
const DEFAULT_VISIBLE_STATES = new Set(['live', 'stale']);
const HOME_PREFIXES = ['/Users/', '/home/'];
const NO_REPO_GROUP_KEY = 'no-repo';
const NO_REPO_LABEL = 'No repo';
const SUCCESS_PENDING_WORKTREE_TTL_MS = 12_000;
const OPEN_TERMINAL_SUCCESS_TTL_MS = 4_000;
const KILL_SESSION_SUCCESS_TTL_MS = 6_000;
const DEFAULT_OPEN_TERMINAL_FAILURE_MESSAGE = 'Could not request terminal open.';
const DEFAULT_KILL_SESSION_FAILURE_MESSAGE = 'Could not request session end.';
const KILL_SESSION_FAILURE_MESSAGES = {
  'invalid-runtime-id': 'Session runtime metadata is invalid.',
  'presence-missing': 'Session runtime metadata is no longer available.',
  'presence-malformed': 'Session runtime metadata is invalid.',
  'runtime-mismatch': 'Session runtime metadata is invalid.',
  'pid-reused': 'The recorded process no longer matches this session.',
  'pid-unverified': 'Could not safely verify the selected process.',
  'self-signal-denied': 'Session Deck cannot signal its own helper process.',
  'permission-denied': 'Termination is not permitted for this process.',
  'signal-failed': DEFAULT_KILL_SESSION_FAILURE_MESSAGE,
};
const DOCTOR_COMMAND = '/session-deck iterm2 doctor';
const AGENT_DIR_MODES = ['ambient', 'default', 'custom'];
const INLINE_WORKTREE_FAILURE_REASONS = new Set([
  'invalid-branch',
  'invalid-base-ref',
  'repo-intent-unresolved',
  'repo-intent-ambiguous',
]);

const state = {
  snapshot: null,
  selectedRuntimeId: null,
  detailVisible: false,
  showAll: false,
  loading: false,
  fetchError: null,
  expandedRepoKeys: new Set(),
  activeWorktreeFormRepoKey: null,
  worktreeForms: new Map(),
  worktreeBasePreviews: new Map(),
  worktreeLaunchPreviews: new Map(),
  nextWorktreeBasePreviewRequestId: 0,
  nextWorktreeLaunchPreviewRequestId: 0,
  pendingWorktrees: new Map(),
  openTerminalAction: null,
  killSessionAction: null,
  highlightedRuntimeId: null,
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
    reconcileOpenTerminalAction();
    reconcileKillSessionAction();
    render();
  });

  if (typeof window.addEventListener === 'function') {
    window.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && clearKillSessionConfirmation()) {
        render();
      }
    });
  }

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
    reconcilePendingWorktrees();
    reconcileOpenTerminalAction();
    reconcileKillSessionAction();
  } catch (error) {
    state.fetchError = error instanceof Error ? error.message : String(error);
    if (source === 'startup') {
      state.snapshot = emptySnapshot(`Snapshot request failed: ${state.fetchError}`);
      reconcileSelection();
      reconcileExpandedRepoKeys();
      reconcileOpenTerminalAction();
      reconcileKillSessionAction();
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
  return records.filter(
    (record) =>
      !isTempSession(record) && (state.showAll || DEFAULT_VISIBLE_STATES.has(record.presenceState)),
  );
}

function reconcileExpandedRepoKeys(repoGroups = createRepoGroups(getVisibleRecords())) {
  const visibleRepoKeys = new Set(repoGroups.map((repoGroup) => repoGroup.key));
  for (const expandedRepoKey of state.expandedRepoKeys) {
    if (!visibleRepoKeys.has(expandedRepoKey)) {
      state.expandedRepoKeys.delete(expandedRepoKey);
    }
  }
}

function reconcilePendingWorktrees(repoGroups = createRepoGroups(getVisibleRecords())) {
  for (const [repoKey, pending] of [...state.pendingWorktrees.entries()]) {
    if (pending.kind !== 'success') {
      continue;
    }

    if (hasObservedPendingWorktreeSuccess(pending, repoGroups)) {
      clearPendingWorktree(repoKey);
    }
  }
}

function reconcileOpenTerminalAction() {
  const action = state.openTerminalAction;
  if (action === null) {
    return;
  }

  const isStillVisible = getVisibleRecords().some(
    (record) => record.runtimeId === action.runtimeId,
  );
  if (!isStillVisible) {
    clearOpenTerminalAction();
  }
}

function reconcileKillSessionAction() {
  const action = state.killSessionAction;
  if (action?.kind !== 'confirming') {
    return;
  }

  const isStillVisible = getVisibleRecords().some(
    (record) => record.runtimeId === action.runtimeId,
  );
  if (!isStillVisible) {
    clearKillSessionAction();
  }
}

function hasObservedPendingWorktreeSuccess(pending, repoGroups) {
  return repoGroups.some((repoGroup) =>
    repoGroup.records.some((record) => doesRecordMatchPendingWorktree(record, pending)),
  );
}

function doesRecordMatchPendingWorktree(record, pending) {
  if (typeof pending.runtimeId === 'string' && record.runtimeId === pending.runtimeId) {
    return true;
  }

  const request = pending.request;
  if (
    !request ||
    record.branch !== request.branchName ||
    !repoIntentMatchesRecord(record, request.repoIntent)
  ) {
    return false;
  }

  return record.isLinkedWorktree === true || isNonEmptyString(record.worktreeLabel);
}

function repoIntentMatchesRecord(record, repoIntent) {
  if (isNonEmptyString(repoIntent.qualifiedRepoName)) {
    return record.qualifiedRepoName === repoIntent.qualifiedRepoName;
  }

  if (!isNonEmptyString(repoIntent.repoName)) {
    return false;
  }

  return (
    record.repoName === repoIntent.repoName ||
    getQualifiedRepoShortName(record.qualifiedRepoName) === repoIntent.repoName
  );
}

function getQualifiedRepoShortName(qualifiedRepoName) {
  return isNonEmptyString(qualifiedRepoName) ? getRepoShortName(qualifiedRepoName) : null;
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
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
  const focusSnapshot = captureRenderFocus();
  renderSummary();
  renderBanner();
  renderList();
  renderDiagnostics();
  restoreRenderFocus(focusSnapshot);
}

function captureRenderFocus() {
  const activeElement = document.activeElement;
  if (!(activeElement instanceof HTMLInputElement)) {
    return null;
  }

  const ariaLabel = activeElement.getAttribute('aria-label');
  if (ariaLabel !== 'Branch name' && ariaLabel !== 'Custom Pi config directory') {
    return null;
  }

  return {
    ariaLabel,
    selectionStart:
      typeof activeElement.selectionStart === 'number' ? activeElement.selectionStart : null,
    selectionEnd:
      typeof activeElement.selectionEnd === 'number' ? activeElement.selectionEnd : null,
  };
}

function restoreRenderFocus(snapshot) {
  if (snapshot === null) {
    return;
  }

  const input = findInputByAriaLabel(elements.list, snapshot.ariaLabel);
  if (input === null) {
    return;
  }

  input.focus?.();
  if (
    typeof input.setSelectionRange === 'function' &&
    typeof snapshot.selectionStart === 'number' &&
    typeof snapshot.selectionEnd === 'number'
  ) {
    const valueLength = input.value.length;
    input.setSelectionRange(
      Math.min(snapshot.selectionStart, valueLength),
      Math.min(snapshot.selectionEnd, valueLength),
    );
  }
}

function findInputByAriaLabel(node, ariaLabel) {
  if (node instanceof HTMLInputElement && node.getAttribute('aria-label') === ariaLabel) {
    return node;
  }

  for (const child of node.childNodes ?? []) {
    const match = findInputByAriaLabel(child, ariaLabel);
    if (match !== null) {
      return match;
    }
  }

  return null;
}

function renderSummary() {
  if (state.loading && state.snapshot === null) {
    elements.summary.textContent = 'Loading…';
    return;
  }

  const snapshot = state.snapshot ?? emptySnapshot('Snapshot unavailable.');
  const counts = countPresenceStates(snapshot.records);
  const tempLive = countLiveTempSessions(snapshot.records);
  const visibleLive = counts.live - tempLive;
  const summaryLabels = [`${visibleLive} live`, `${tempLive} temp`, `${counts.stale} stale`];

  if (state.showAll) {
    summaryLabels.push(`${counts.dead} dead`, `${counts.unknown} unknown`);
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

  const headerRow = document.createElement('div');
  headerRow.className = 'repo-header-row';
  headerRow.append(header);

  if (repoGroup.kind !== 'no-repo') {
    headerRow.append(createRepoActionButton(repoGroup));
  }

  section.append(headerRow);

  if (state.activeWorktreeFormRepoKey === repoGroup.key) {
    section.append(createWorktreeForm(repoGroup));
  }

  if (isExpanded) {
    const records = document.createElement('div');
    const recordsId = getRepoGroupRecordsId(repoGroup.key);
    records.className = 'repo-group-records';
    records.setAttribute('id', recordsId);
    records.setAttribute('role', 'list');
    records.setAttribute('aria-label', `${repoGroup.label} sessions`);
    header.setAttribute('aria-controls', recordsId);

    const pending = state.pendingWorktrees.get(repoGroup.key);
    if (pending) {
      records.append(createPendingWorktreeCard(repoGroup.key, pending));
    }

    for (const record of repoGroup.records) {
      records.append(createRecordCard(record));
    }
    section.append(records);
  }

  return section;
}

function createRepoActionButton(repoGroup) {
  const isOpen = state.activeWorktreeFormRepoKey === repoGroup.key;
  const label = isOpen ? 'cancel new session' : 'create new session';
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'repo-action-button';
  button.textContent = isOpen ? 'Cancel' : '+ New';
  button.setAttribute('aria-label', label);
  button.setAttribute('title', label);
  button.addEventListener('click', (event) => {
    event.preventDefault?.();
    event.stopPropagation?.();

    if (isOpen) {
      closeWorktreeForm(repoGroup.key);
      return;
    }

    if (state.pendingWorktrees.get(repoGroup.key)?.kind === 'pending') {
      return;
    }

    state.activeWorktreeFormRepoKey = repoGroup.key;
    if (!state.worktreeForms.has(repoGroup.key)) {
      state.worktreeForms.set(repoGroup.key, createInitialWorktreeFormState());
    }
    requestWorktreeBasePreview(repoGroup);
    requestWorktreeLaunchPreview(repoGroup);
    render();
  });
  return button;
}

function closeWorktreeForm(repoKey) {
  clearWorktreeFormState(repoKey);
  render();
}

function clearWorktreeFormState(repoKey) {
  state.worktreeForms.delete(repoKey);
  state.worktreeBasePreviews.delete(repoKey);
  state.worktreeLaunchPreviews.delete(repoKey);
  if (state.activeWorktreeFormRepoKey === repoKey) {
    state.activeWorktreeFormRepoKey = null;
  }
}

function createWorktreeForm(repoGroup) {
  const formState = getWorktreeFormState(repoGroup.key);
  const preview = state.worktreeBasePreviews.get(repoGroup.key);
  const launchPreview = state.worktreeLaunchPreviews.get(repoGroup.key);
  const customValidation = validateWorktreeFormAgentDir(formState);
  const inlineMessage = getWorktreeFormInlineMessage(formState, preview, customValidation);
  const form = document.createElement('form');
  form.className = 'worktree-form';
  form.addEventListener('submit', (event) => {
    event.preventDefault?.();
    submitWorktreeForm(repoGroup, formState);
  });
  form.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') {
      return;
    }
    event.preventDefault?.();
    event.stopPropagation?.();
    if (formState.configDrawerOpen) {
      formState.configDrawerOpen = false;
      render();
      return;
    }
    closeWorktreeForm(repoGroup.key);
  });

  const labelInput = document.createElement('input');
  labelInput.type = 'text';
  labelInput.value = formState.branchName;
  labelInput.setAttribute('aria-label', 'Branch name');
  labelInput.setAttribute('placeholder', 'feat/feature-name');
  labelInput.addEventListener('input', () => {
    formState.branchName = labelInput.value;
  });

  const fieldMeta = createText(
    'span',
    formatWorktreeBasePreviewCopy(preview),
    'worktree-field-meta',
  );
  fieldMeta.setAttribute('data-state', preview?.status ?? 'loading');

  const submit = document.createElement('button');
  submit.type = 'submit';
  submit.className = 'worktree-submit-button';
  submit.textContent = 'Create';
  submit.disabled =
    !isResolvedWorktreeBasePreview(preview) ||
    customValidation !== null ||
    state.pendingWorktrees.has(repoGroup.key);

  const branchControl = document.createElement('div');
  branchControl.className = 'worktree-branch-control';
  branchControl.append(labelInput, submit);

  const composeRow = document.createElement('div');
  composeRow.className = 'worktree-compose-row';
  composeRow.append(fieldMeta, branchControl);

  form.append(composeRow, createWorktreeConfigRow(repoGroup, formState, launchPreview));
  if (formState.configDrawerOpen) {
    form.append(createWorktreeConfigDrawer(repoGroup, formState));
  }
  if (inlineMessage) {
    form.append(createText('div', inlineMessage, 'worktree-form-feedback worktree-form-error'));
  }
  return form;
}

function createInitialWorktreeFormState() {
  return {
    branchName: '',
    errorMessage: null,
    agentDirSelection: { mode: 'ambient' },
    customDraft: '',
    configDrawerOpen: false,
  };
}

function getWorktreeFormState(repoKey) {
  const existing = state.worktreeForms.get(repoKey);
  if (existing) {
    return existing;
  }
  const created = createInitialWorktreeFormState();
  state.worktreeForms.set(repoKey, created);
  return created;
}

function createWorktreeConfigRow(repoGroup, formState, launchPreview) {
  const row = document.createElement('div');
  row.className = 'worktree-config-row';
  row.setAttribute('aria-label', 'Pi config');

  const summary = createText(
    'span',
    formatWorktreeLaunchPreviewCopy(launchPreview),
    'worktree-field-meta worktree-config-summary',
  );
  summary.setAttribute('data-state', launchPreview?.status ?? 'loading');

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'worktree-config-button';
  button.textContent = 'Change';
  button.setAttribute('aria-label', 'Change Pi config');
  button.setAttribute('aria-expanded', String(formState.configDrawerOpen));
  button.addEventListener('click', (event) => {
    event.preventDefault?.();
    formState.configDrawerOpen = !formState.configDrawerOpen;
    render();
  });

  row.append(summary, button);
  return row;
}

function createWorktreeConfigDrawer(repoGroup, formState) {
  const drawer = document.createElement('div');
  drawer.className = 'worktree-config-drawer';
  drawer.setAttribute('role', 'radiogroup');
  drawer.setAttribute('aria-label', 'Pi config');

  for (const mode of AGENT_DIR_MODES) {
    const option = document.createElement('button');
    option.type = 'button';
    option.className = 'worktree-config-option';
    option.setAttribute('role', 'radio');
    option.setAttribute('aria-checked', String(formState.agentDirSelection.mode === mode));
    option.textContent = formatWorktreeAgentDirOptionLabel(mode);
    option.addEventListener('click', (event) => {
      event.preventDefault?.();
      formState.agentDirSelection =
        mode === 'custom' ? { mode, customDir: formState.customDraft } : { mode };
      requestWorktreeLaunchPreview(repoGroup);
      render();
    });
    drawer.append(option);
  }

  const customInput = document.createElement('input');
  customInput.type = 'text';
  customInput.value = formState.customDraft;
  customInput.setAttribute('aria-label', 'Custom Pi config directory');
  customInput.setAttribute('placeholder', '~/.pi/agent-work');
  customInput.addEventListener('input', () => {
    formState.customDraft = customInput.value;
    if (formState.agentDirSelection.mode === 'custom') {
      formState.agentDirSelection = { mode: 'custom', customDir: formState.customDraft };
      requestWorktreeLaunchPreview(repoGroup);
    }
    render();
  });
  drawer.append(customInput);
  return drawer;
}

function getWorktreeFormInlineMessage(formState, preview, customValidation) {
  if (isNonEmptyString(formState.errorMessage)) {
    return formState.errorMessage;
  }
  if (customValidation !== null) {
    return customValidation;
  }
  return preview?.status === 'failed' && isNonEmptyString(preview.message) ? preview.message : null;
}

function createPendingWorktreeCard(repoKey, pending) {
  const card = document.createElement('article');
  card.className = `pending-worktree ${pending.tone}`;

  const header = document.createElement('div');
  header.className = 'pending-worktree-header';
  header.append(createText('div', pending.title, 'pending-worktree-title'));
  if (isPendingWorktreeDismissible(pending)) {
    header.append(createPendingWorktreeDismissButton(repoKey, pending));
  }

  card.append(header, createText('div', pending.message, 'pending-worktree-message'));

  if (Array.isArray(pending.actions) && pending.actions.length > 0) {
    const actions = document.createElement('div');
    actions.className = 'pending-worktree-actions';
    for (const action of pending.actions) {
      actions.append(createPendingWorktreeActionButton(action));
    }
    card.append(actions);
  }

  return card;
}

function isPendingWorktreeDismissible(pending) {
  return pending.kind !== 'pending';
}

function createPendingWorktreeDismissButton(repoKey, pending) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'pending-worktree-dismiss';
  button.textContent = '×';
  button.setAttribute('aria-label', `Dismiss ${pending.title}`);
  button.addEventListener('click', (event) => {
    event.preventDefault?.();
    event.stopPropagation?.();
    clearPendingWorktree(repoKey);
    render();
  });
  return button;
}

function createPendingWorktreeActionButton(action) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = action.kind
    ? `pending-worktree-action ${action.kind}`
    : 'pending-worktree-action';
  button.textContent = action.label;
  button.disabled = action.disabled === true;
  if (isNonEmptyString(action.title)) {
    button.setAttribute('title', action.title);
  }
  button.addEventListener('click', (event) => {
    event.preventDefault?.();
    action.onClick?.();
  });
  return button;
}

function requestWorktreeBasePreview(repoGroup) {
  const requestId = state.nextWorktreeBasePreviewRequestId + 1;
  state.nextWorktreeBasePreviewRequestId = requestId;
  state.worktreeBasePreviews.set(repoGroup.key, { status: 'loading', requestId });

  void postWorktreeBasePreview(repoGroup)
    .then((result) => {
      const activePreview = state.worktreeBasePreviews.get(repoGroup.key);
      if (activePreview?.requestId !== requestId) {
        return;
      }

      if (result?.ok && typeof result.baseRef === 'string' && result.baseRef.trim().length > 0) {
        state.worktreeBasePreviews.set(repoGroup.key, {
          status: 'resolved',
          baseRef: result.baseRef,
        });
      } else {
        state.worktreeBasePreviews.set(repoGroup.key, {
          status: 'failed',
          message: getWorktreeBasePreviewFailureMessage(result),
        });
      }
      render();
    })
    .catch(() => {
      const activePreview = state.worktreeBasePreviews.get(repoGroup.key);
      if (activePreview?.requestId !== requestId) {
        return;
      }
      state.worktreeBasePreviews.set(repoGroup.key, {
        status: 'failed',
        message: 'Base unavailable.',
      });
      render();
    });
}

function getWorktreeBasePreviewFailureMessage(result) {
  return isNonEmptyString(result?.message) ? result.message : 'Base unavailable.';
}

function requestWorktreeLaunchPreview(repoGroup) {
  const formState = getWorktreeFormState(repoGroup.key);
  const requestId = state.nextWorktreeLaunchPreviewRequestId + 1;
  state.nextWorktreeLaunchPreviewRequestId = requestId;
  state.worktreeLaunchPreviews.set(repoGroup.key, { status: 'loading', requestId });

  void postWorktreeLaunchPreview(formState)
    .then((result) => {
      const activePreview = state.worktreeLaunchPreviews.get(repoGroup.key);
      if (activePreview?.requestId !== requestId) {
        return;
      }

      if (result?.ok && result.status === 'resolved') {
        state.worktreeLaunchPreviews.set(repoGroup.key, result);
      } else {
        state.worktreeLaunchPreviews.set(repoGroup.key, {
          status: 'failed',
          message: isNonEmptyString(result?.message) ? result.message : 'Pi config unavailable.',
        });
      }
      render();
    })
    .catch(() => {
      const activePreview = state.worktreeLaunchPreviews.get(repoGroup.key);
      if (activePreview?.requestId !== requestId) {
        return;
      }
      state.worktreeLaunchPreviews.set(repoGroup.key, {
        status: 'failed',
        message: 'Pi config unavailable.',
      });
      render();
    });
}

function formatWorktreeBasePreviewCopy(preview) {
  if (isResolvedWorktreeBasePreview(preview)) {
    return `${formatBaseRefLabel(preview.baseRef)} →`;
  }
  if (preview?.status === 'failed') {
    return 'Base unavailable';
  }
  return 'Resolving…';
}

function isResolvedWorktreeBasePreview(preview) {
  return (
    preview?.status === 'resolved' &&
    typeof preview.baseRef === 'string' &&
    preview.baseRef.trim().length > 0
  );
}

function formatBaseRefLabel(baseRef) {
  const trimmed = typeof baseRef === 'string' ? baseRef.trim() : '';
  if (trimmed.length === 0 || trimmed === 'HEAD') {
    return 'current HEAD';
  }

  const normalized = trimmed
    .replace(/^refs\/remotes\//u, '')
    .replace(/^refs\/heads\//u, '')
    .replace(/^origin\//u, '');
  return normalized.length > 0 ? normalized : trimmed;
}

function formatWorktreeLaunchPreviewCopy(preview) {
  if (preview?.status === 'resolved') {
    return `Pi config → ${preview.effectiveDisplay}`;
  }
  if (preview?.status === 'failed') {
    return 'Pi config unavailable';
  }
  return 'Pi config resolving…';
}

function formatWorktreeAgentDirOptionLabel(mode) {
  switch (mode) {
    case 'default':
      return 'Pi default';
    case 'custom':
      return 'Custom…';
    default:
      return 'Current';
  }
}

function validateWorktreeFormAgentDir(formState) {
  if (formState.agentDirSelection.mode !== 'custom') {
    return null;
  }
  const normalized = normalizeCustomAgentDir(formState.customDraft);
  return normalized.ok ? null : normalized.message;
}

function normalizeWorktreeFormAgentDir(formState) {
  if (formState.agentDirSelection.mode !== 'custom') {
    return { ok: true, agentDir: { mode: formState.agentDirSelection.mode } };
  }
  const normalized = normalizeCustomAgentDir(formState.customDraft);
  return normalized.ok
    ? { ok: true, agentDir: { mode: 'custom', customDir: normalized.value } }
    : normalized;
}

function normalizeCustomAgentDir(value) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return { ok: false, message: 'Custom Pi config must be non-empty.' };
  }
  if (value.includes('\0') || /[\r\n]/u.test(value)) {
    return { ok: false, message: 'Custom Pi config must not contain newlines.' };
  }
  const trimmed = value.trim();
  if (trimmed.startsWith('~/')) {
    return { ok: true, value: trimmed };
  }
  if (trimmed.startsWith('/')) {
    return { ok: true, value: normalizeAbsolutePathText(trimmed) };
  }
  return { ok: false, message: 'Custom Pi config must be absolute or start with ~/.' };
}

function normalizeAbsolutePathText(value) {
  const parts = [];
  for (const part of value.split('/')) {
    if (part.length === 0 || part === '.') {
      continue;
    }
    if (part === '..') {
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return `/${parts.join('/')}`;
}

function submitWorktreeForm(repoGroup, formState) {
  const branchName = formState.branchName.trim();
  const preview = state.worktreeBasePreviews.get(repoGroup.key);
  const agentDir = normalizeWorktreeFormAgentDir(formState);
  if (
    branchName.length === 0 ||
    state.pendingWorktrees.has(repoGroup.key) ||
    !isResolvedWorktreeBasePreview(preview) ||
    !agentDir.ok
  ) {
    return;
  }

  const request = buildCreateWorktreeRequest(
    repoGroup,
    branchName,
    preview.baseRef,
    agentDir.agentDir,
  );
  formState.branchName = branchName;
  formState.errorMessage = null;
  setPendingWorktree(repoGroup.key, {
    kind: 'pending',
    title: 'New session',
    message: 'Creating worktree…',
    tone: 'pending',
  });
  state.expandedRepoKeys.add(repoGroup.key);
  state.activeWorktreeFormRepoKey = null;
  render();

  void postCreateWorktreeAction(request)
    .then(async (result) => {
      const inlineFailureMessage = getRecoverableInlineWorktreeFailureMessage(result);
      if (inlineFailureMessage !== null) {
        clearPendingWorktree(repoGroup.key);
        state.worktreeForms.set(repoGroup.key, {
          ...formState,
          branchName,
          errorMessage: inlineFailureMessage,
        });
        state.activeWorktreeFormRepoKey = repoGroup.key;
        render();
        return;
      }

      clearWorktreeFormState(repoGroup.key);
      applyWorktreeActionResult(repoGroup.key, request, result);
      render();
      if (shouldRefreshAfterWorktreeActionResult(result)) {
        await refreshSnapshot({ source: 'manual' });
      }
    })
    .catch((error) => {
      clearWorktreeFormState(repoGroup.key);
      setPendingWorktree(repoGroup.key, {
        kind: 'failure',
        title: 'New session failed',
        message: `Create worktree failed: ${error instanceof Error ? error.message : String(error)}`,
        tone: 'failed',
      });
      render();
    });
}

function buildWorktreeRepoIntent(repoGroup) {
  return {
    repoName: getRepoShortName(repoGroup.label),
    qualifiedRepoName: repoGroup.kind === 'qualified' ? repoGroup.label : null,
    candidateRuntimeIds: repoGroup.records.map((record) => record.runtimeId),
  };
}

function buildCreateWorktreeRequest(repoGroup, branchName, baseRef, agentDir) {
  return {
    repoIntent: buildWorktreeRepoIntent(repoGroup),
    branchName,
    baseRef,
    launch: { mode: 'tmux-detached', agentDir },
  };
}

async function postWorktreeBasePreview(repoGroup) {
  const response = await fetch('/actions/create-worktree-preview', {
    method: 'POST',
    cache: 'no-store',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'X-Session-Deck-Action-Token': getActionToken(),
    },
    body: JSON.stringify({
      action: 'preview-base-ref',
      repoIntent: buildWorktreeRepoIntent(repoGroup),
    }),
  });

  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload?.message ?? `HTTP ${response.status}`);
  }
  return payload;
}

async function postWorktreeLaunchPreview(formState) {
  const agentDir = normalizeWorktreeFormAgentDir(formState);
  const response = await fetch('/actions/create-worktree-preview', {
    method: 'POST',
    cache: 'no-store',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'X-Session-Deck-Action-Token': getActionToken(),
    },
    body: JSON.stringify({
      action: 'preview-launch-context',
      launch: {
        mode: 'tmux-detached',
        agentDir: agentDir.ok ? agentDir.agentDir : formState.agentDirSelection,
      },
    }),
  });

  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload?.message ?? `HTTP ${response.status}`);
  }
  return payload;
}

async function postCreateWorktreeAction(request) {
  const response = await fetch('/actions/create-worktree', {
    method: 'POST',
    cache: 'no-store',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'X-Session-Deck-Action-Token': getActionToken(),
    },
    body: JSON.stringify(request),
  });

  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload?.message ?? `HTTP ${response.status}`);
  }
  return payload;
}

async function postOpenTerminalAction(runtimeId) {
  const response = await fetch('/actions/open-terminal', {
    method: 'POST',
    cache: 'no-store',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'X-Session-Deck-Action-Token': getActionToken(),
    },
    body: JSON.stringify({ runtimeId }),
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(
      isNonEmptyString(payload?.message) ? payload.message : `HTTP ${response.status}`,
    );
  }
  return payload;
}

async function postKillSessionAction(runtimeId) {
  const response = await fetch('/actions/kill-session', {
    method: 'POST',
    cache: 'no-store',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'X-Session-Deck-Action-Token': getActionToken(),
    },
    body: JSON.stringify({ runtimeId }),
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(
      isNonEmptyString(payload?.message) ? payload.message : `HTTP ${response.status}`,
    );
  }
  return payload;
}

function getRecoverableInlineWorktreeFailureMessage(result) {
  if (result?.ok === false && result?.status === 'preflight-failed') {
    return getPreflightFailureMessage(result.preflight);
  }
  return result?.ok === false &&
    result?.status === 'failed' &&
    INLINE_WORKTREE_FAILURE_REASONS.has(result.worktree?.reason)
    ? (result.worktree?.message ?? 'New session request is invalid.')
    : null;
}

function applyWorktreeActionResult(repoKey, request, result) {
  setPendingWorktree(repoKey, summarizeWorktreeActionResult(repoKey, request, result));
  const runtimeId = getActionResultRuntimeId(result);
  if (runtimeId) {
    state.highlightedRuntimeId = runtimeId;
  }
}

function shouldRefreshAfterWorktreeActionResult(result) {
  return result?.status !== 'preflight-failed';
}

function retryWorktreeAction(repoKey, request) {
  setPendingWorktree(repoKey, {
    kind: 'pending',
    title: 'Retrying launch',
    message: 'Retrying Pi launch…',
    tone: 'pending',
  });
  state.expandedRepoKeys.add(repoKey);
  render();

  void postCreateWorktreeAction(request)
    .then(async (result) => {
      applyWorktreeActionResult(repoKey, request, result);
      render();
      if (shouldRefreshAfterWorktreeActionResult(result)) {
        await refreshSnapshot({ source: 'manual' });
      }
    })
    .catch((error) => {
      setPendingWorktree(repoKey, {
        kind: 'failure',
        title: 'Retry failed',
        message: `Create worktree failed: ${error instanceof Error ? error.message : String(error)}`,
        tone: 'failed',
      });
      render();
    });
}

function summarizeWorktreeActionResult(repoKey, request, result) {
  if (result?.status === 'preflight-failed') {
    return {
      kind: 'failure',
      title: 'New session blocked',
      message: getPreflightFailureMessage(result.preflight),
      tone: 'failed',
    };
  }

  if (result?.status === 'partial-launch-failed') {
    return {
      kind: 'partial',
      title: 'Worktree ready · Pi did not start',
      message: getPartialLaunchFailureMessage(result.launch),
      tone: 'partial',
      actions: buildPartialLaunchActions(repoKey, request),
    };
  }

  if (!result?.ok) {
    return {
      kind: 'failure',
      title: 'New session failed',
      message: result.worktree?.message ?? 'New session failed.',
      tone: 'failed',
    };
  }

  if (!result.launch?.requested) {
    return {
      kind: 'success',
      title: 'Worktree ready',
      message: 'Worktree created.',
      tone: 'ready',
      request,
      autoDismissAfterMs: SUCCESS_PENDING_WORKTREE_TTL_MS,
    };
  }

  return {
    kind: 'success',
    title:
      result.status === 'reused-and-launched' || result.launch.status === 'reused-existing'
        ? 'Session reused'
        : 'Session launched',
    message:
      result.status === 'reused-and-launched' || result.launch.status === 'reused-existing'
        ? 'Reused the managed Pi session. Session Deck will pick it up automatically.'
        : 'Pi session launched. Session Deck will pick it up automatically.',
    tone: 'ready',
    request,
    runtimeId: getActionResultRuntimeId(result),
    autoDismissAfterMs: SUCCESS_PENDING_WORKTREE_TTL_MS,
  };
}

function getActionResultRuntimeId(result) {
  return result?.launch?.ok && isNonEmptyString(result.launch.runtimeId)
    ? result.launch.runtimeId
    : null;
}

function getPreflightFailureMessage(preflight) {
  switch (preflight?.reason) {
    case 'tmux-unavailable':
      return `New Pi session requires tmux on PATH; no worktree was created. Run ${DOCTOR_COMMAND} or install tmux.`;
    case 'pi-command-unavailable':
      return `New Pi session requires the pi executable on PATH; no worktree was created. Run ${DOCTOR_COMMAND} or install Pi.`;
    default:
      return isNonEmptyString(preflight?.message)
        ? preflight.message
        : `New Pi session prerequisites are unavailable; no worktree was created. Run ${DOCTOR_COMMAND}.`;
  }
}

function getPartialLaunchFailureMessage(launch) {
  switch (launch?.reason) {
    case 'tmux-unavailable':
      return `Worktree kept. Pi did not start because tmux is not available. Run ${DOCTOR_COMMAND} or install tmux, then retry.`;
    case 'pi-command-unavailable':
      return `Worktree kept. Pi did not start because the pi executable is not available. Run ${DOCTOR_COMMAND} or install Pi, then retry.`;
    case 'tmux-name-collision':
      return 'Worktree kept. Pi did not start because the generated tmux session name is already in use. Retry after resolving the collision.';
    case 'launch-context-mismatch':
      return 'Worktree kept. Pi did not start because an existing managed tmux session may use a different Pi config. Attach to it or choose Current.';
    case 'presence-timeout':
      return 'Worktree kept. Session Deck could not confirm the Pi launch. Retry after confirming the session can start.';
    case 'spawn-failed':
      return 'Worktree kept. Pi did not start. Retry after fixing the launch issue.';
    default:
      return isNonEmptyString(launch?.message)
        ? `${launch.message} Retry after fixing the launch issue.`
        : 'Worktree kept. Pi did not start. Retry after fixing the launch issue.';
  }
}

function buildPartialLaunchActions(repoKey, request) {
  return [
    {
      label: 'Retry',
      kind: 'primary',
      onClick: () => {
        retryWorktreeAction(repoKey, request);
      },
    },
  ];
}

function setPendingWorktree(repoKey, pending) {
  clearPendingWorktree(repoKey);
  const nextPending = { ...pending };
  if (
    typeof nextPending.autoDismissAfterMs === 'number' &&
    typeof window.setTimeout === 'function'
  ) {
    nextPending.timeoutId = window.setTimeout(() => {
      if (state.pendingWorktrees.get(repoKey) === nextPending) {
        state.pendingWorktrees.delete(repoKey);
        render();
      }
    }, nextPending.autoDismissAfterMs);
  }
  state.pendingWorktrees.set(repoKey, nextPending);
}

function clearPendingWorktree(repoKey) {
  const pending = state.pendingWorktrees.get(repoKey);
  if (pending && pending.timeoutId !== undefined && typeof window.clearTimeout === 'function') {
    window.clearTimeout(pending.timeoutId);
  }
  state.pendingWorktrees.delete(repoKey);
}

function setOpenTerminalAction(action) {
  clearOpenTerminalAction();
  const nextAction = { ...action };
  if (nextAction.kind === 'success' && typeof window.setTimeout === 'function') {
    nextAction.timeoutId = window.setTimeout(() => {
      if (state.openTerminalAction === nextAction) {
        state.openTerminalAction = null;
        render();
      }
    }, OPEN_TERMINAL_SUCCESS_TTL_MS);
  }
  state.openTerminalAction = nextAction;
  return nextAction;
}

function clearOpenTerminalAction() {
  const action = state.openTerminalAction;
  if (action && action.timeoutId !== undefined && typeof window.clearTimeout === 'function') {
    window.clearTimeout(action.timeoutId);
  }
  state.openTerminalAction = null;
}

function getOpenTerminalActionForRecord(record) {
  return state.openTerminalAction?.runtimeId === record.runtimeId ? state.openTerminalAction : null;
}

function openRecordTerminal(record) {
  if (state.openTerminalAction?.kind === 'pending') {
    return;
  }

  const pendingAction = setOpenTerminalAction({ kind: 'pending', runtimeId: record.runtimeId });
  render();

  void postOpenTerminalAction(record.runtimeId)
    .then((result) => {
      if (state.openTerminalAction !== pendingAction) {
        return;
      }

      if (result?.ok === true) {
        setOpenTerminalAction({
          kind: 'success',
          runtimeId: record.runtimeId,
          message: isNonEmptyString(result.message) ? result.message : 'Terminal open requested.',
        });
      } else {
        setOpenTerminalAction({
          kind: 'failure',
          runtimeId: record.runtimeId,
          message: getOpenTerminalActionFailureMessage(result),
        });
      }
      render();
    })
    .catch((error) => {
      if (state.openTerminalAction !== pendingAction) {
        return;
      }

      setOpenTerminalAction({
        kind: 'failure',
        runtimeId: record.runtimeId,
        message:
          error instanceof Error && isNonEmptyString(error.message)
            ? error.message
            : DEFAULT_OPEN_TERMINAL_FAILURE_MESSAGE,
      });
      render();
    });
}

function getOpenTerminalActionFailureMessage(result) {
  return isNonEmptyString(result?.message) ? result.message : DEFAULT_OPEN_TERMINAL_FAILURE_MESSAGE;
}

function setKillSessionAction(action) {
  clearKillSessionAction();
  const nextAction = { ...action };
  if (nextAction.kind === 'success' && typeof window.setTimeout === 'function') {
    nextAction.timeoutId = window.setTimeout(() => {
      if (state.killSessionAction === nextAction) {
        state.killSessionAction = null;
        render();
      }
    }, KILL_SESSION_SUCCESS_TTL_MS);
  }
  state.killSessionAction = nextAction;
  return nextAction;
}

function clearKillSessionAction() {
  const action = state.killSessionAction;
  if (action && action.timeoutId !== undefined && typeof window.clearTimeout === 'function') {
    window.clearTimeout(action.timeoutId);
  }
  state.killSessionAction = null;
}

function clearKillSessionConfirmation() {
  if (state.killSessionAction?.kind !== 'confirming') {
    return false;
  }
  clearKillSessionAction();
  return true;
}

function getKillSessionActionForRecord(record) {
  return state.killSessionAction?.runtimeId === record.runtimeId ? state.killSessionAction : null;
}

function openKillSessionConfirmation(record) {
  if (state.killSessionAction?.kind === 'pending') {
    return;
  }

  setKillSessionAction({ kind: 'confirming', runtimeId: record.runtimeId });
  render();
}

function confirmKillSession(record) {
  if (state.killSessionAction?.kind === 'pending') {
    return;
  }

  const pendingAction = setKillSessionAction({ kind: 'pending', runtimeId: record.runtimeId });
  render();

  void postKillSessionAction(record.runtimeId)
    .then((result) => {
      if (state.killSessionAction !== pendingAction) {
        return;
      }

      if (result?.ok === true) {
        setKillSessionAction({
          kind: 'success',
          runtimeId: record.runtimeId,
          message: getKillSessionActionSuccessMessage(result),
        });
        void refreshSnapshot({ source: 'manual' });
      } else {
        setKillSessionAction({
          kind: 'failure',
          runtimeId: record.runtimeId,
          message: getKillSessionActionFailureMessage(result),
        });
      }
      render();
    })
    .catch((error) => {
      if (state.killSessionAction !== pendingAction) {
        return;
      }

      setKillSessionAction({
        kind: 'failure',
        runtimeId: record.runtimeId,
        message:
          error instanceof Error && isNonEmptyString(error.message)
            ? error.message
            : DEFAULT_KILL_SESSION_FAILURE_MESSAGE,
      });
      render();
    });
}

function getKillSessionActionSuccessMessage(result) {
  return result?.status === 'already-exited'
    ? 'This Pi session is no longer running.'
    : 'End requested for this session.';
}

function getKillSessionActionFailureMessage(result) {
  return KILL_SESSION_FAILURE_MESSAGES[result?.reason] ?? DEFAULT_KILL_SESSION_FAILURE_MESSAGE;
}

function getActionToken() {
  const tokenElement = document.getElementById('session-deck-action-token');
  return tokenElement?.getAttribute?.('content') ?? '';
}

function createRecordCard(record) {
  const isExpanded = state.detailVisible && record.runtimeId === state.selectedRuntimeId;
  const title = getDisplayTitle(record);
  const card = document.createElement('article');
  card.className = `card ${record.presenceState}`;
  card.classList.toggle('expanded', isExpanded);
  card.classList.toggle('highlighted', state.highlightedRuntimeId === record.runtimeId);
  card.setAttribute('role', 'listitem');

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'card-toggle';
  toggle.setAttribute('aria-expanded', String(isExpanded));
  toggle.addEventListener('click', () => {
    clearKillSessionConfirmation();
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
      createText('span', getRowActivityLabel(record), 'row-activity'),
      createText('span', formatDuration(getListAgeMs(record)), 'muted row-age'),
    ]),
    createLine(
      'row-line2',
      [
        getRepoLabel(record, title.source),
        formatPr(record.prUrl),
        record.branch,
        formatChildRuntimeLabel(record),
      ]
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

  card.append(toggle, createRecordOpenButton(record, title.text));
  if (isExpanded) {
    card.append(createRecordDetail(record));
  }

  return card;
}

function createRecordOpenButton(record, title) {
  const action = getOpenTerminalActionForRecord(record);
  const isOpenPending = state.openTerminalAction?.kind === 'pending';
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'card-open';
  button.disabled = isOpenPending;
  button.textContent = getOpenTerminalButtonText(action);
  const label = getOpenTerminalButtonLabel(title, action);
  button.setAttribute('aria-label', label);
  button.setAttribute('title', label);
  if (action !== null) {
    button.setAttribute('data-state', action.kind);
  }
  button.addEventListener('click', (event) => {
    event.preventDefault?.();
    event.stopPropagation?.();
    openRecordTerminal(record);
  });
  return button;
}

function getOpenTerminalButtonText(action) {
  switch (action?.kind) {
    case 'success':
      return '✓';
    case 'failure':
      return '!';
    default:
      return '↗';
  }
}

function getOpenTerminalButtonLabel(title, action) {
  switch (action?.kind) {
    case 'pending':
      return `Opening terminal for ${title}`;
    case 'success':
      return `Terminal open requested for ${title}`;
    case 'failure':
      return `Open terminal failed for ${title}: ${action.message}`;
    default:
      return `Open terminal for ${title}`;
  }
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
        middleTruncateTail: 12,
      }),
      createDetailRow('Runtime ID', record.runtimeId, {
        copyLabel: 'Runtime ID',
        copyValue: record.runtimeId,
        middleTruncateTail: 12,
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
        middleTruncateTail: 24,
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
    createKillSessionSection(record),
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

function createKillSessionSection(record) {
  const action = getKillSessionActionForRecord(record);
  const content = [];

  if (action?.kind === 'confirming') {
    const panel = document.createElement('div');
    panel.className = 'stop-confirmation';

    const copy = document.createElement('p');
    copy.className = 'stop-confirmation-copy';
    copy.textContent =
      'Ending this session sends SIGTERM to the Pi runtime only. Session history is preserved.';

    const actions = document.createElement('div');
    actions.className = 'stop-confirmation-actions';

    const confirm = document.createElement('button');
    confirm.type = 'button';
    confirm.className = 'stop-confirm stop-confirm-primary';
    confirm.textContent = 'End session';
    confirm.addEventListener('click', (event) => {
      event.preventDefault?.();
      event.stopPropagation?.();
      confirmKillSession(record);
    });

    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'stop-confirm';
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', (event) => {
      event.preventDefault?.();
      event.stopPropagation?.();
      clearKillSessionAction();
      render();
    });

    actions.append(confirm, cancel);
    panel.append(copy, actions);
    content.push(panel);

    if (typeof window.setTimeout === 'function') {
      window.setTimeout(() => {
        confirm.focus?.();
      }, 0);
    }
  } else {
    const row = document.createElement('div');
    row.className = 'stop-action-row';

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'stop-action-button';
    button.textContent = getKillSessionButtonText(action);
    button.disabled = state.killSessionAction?.kind === 'pending';
    button.addEventListener('click', (event) => {
      event.preventDefault?.();
      event.stopPropagation?.();
      openKillSessionConfirmation(record);
    });
    row.append(button);
    content.push(row);
  }

  if (action?.kind === 'pending') {
    content.push(createText('p', 'Requesting session end…', 'stop-action-message'));
  } else if (action?.kind === 'success' || action?.kind === 'failure') {
    content.push(
      createText(
        'p',
        action.message,
        action.kind === 'failure'
          ? 'stop-action-message stop-action-failure'
          : 'stop-action-message',
      ),
    );
  }

  return createDetailSection(null, content, { ariaLabel: 'Session actions' });
}

function getKillSessionButtonText(action) {
  switch (action?.kind) {
    case 'pending':
      return 'Ending…';
    case 'success':
      return 'End requested';
    case 'failure':
      return 'Retry end';
    default:
      return 'End session';
  }
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
    createDetailRow('Child runtime', formatChildRuntimeDetail(record)),
    createDetailRow('Current tool', record.currentToolName),
    createDetailRow('Last error', record.lastError),
  );

  return createDetailSection('STATUS', content);
}

function createDetailSection(title, children, options = {}) {
  const section = document.createElement('section');
  section.className = 'detail-section';
  if (options.ariaLabel) {
    section.setAttribute('aria-label', options.ariaLabel);
  }
  if (title) {
    section.append(createText('div', title, 'detail-section-title'));
  }

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
    createDetailValue(value, options.linkHref ?? null, options.middleTruncateTail ?? null),
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

function countLiveTempSessions(records) {
  return records.filter((record) => record.presenceState === 'live' && isTempSession(record))
    .length;
}

function isTempSession(record) {
  return record.derivedFacets?.rowKind === 'ephemeral_child_runtime';
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

function formatChildRuntimeLabel(record) {
  const childRuntime = getUsefulChildRuntime(record);
  if (!childRuntime) {
    return null;
  }

  return `child: ${childRuntime.confidence}`;
}

function formatChildRuntimeDetail(record) {
  const childRuntime = getUsefulChildRuntime(record);
  if (!childRuntime) {
    return null;
  }

  const evidenceLabels = childRuntime.evidence
    .filter((evidence) => evidence.confidence !== 'low')
    .map((evidence) => formatChildRuntimeEvidence(evidence.code))
    .filter((label, index, labels) => labels.indexOf(label) === index)
    .slice(0, 2);
  const via = evidenceLabels.length === 0 ? '' : ` via ${evidenceLabels.join(' + ')}`;
  const parent = childRuntime.parentRuntimeId
    ? ` · parent ${formatShortId(childRuntime.parentRuntimeId)}`
    : '';
  return `${childRuntime.confidence}${via}${parent}`;
}

function getUsefulChildRuntime(record) {
  const derivedFacets = record.derivedFacets;
  const childRuntime = derivedFacets?.childRuntime;
  if (
    derivedFacets?.rowKind !== 'ephemeral_child_runtime' ||
    !childRuntime ||
    !isUsefulChildRuntimeConfidence(childRuntime.confidence) ||
    !Array.isArray(childRuntime.evidence)
  ) {
    return null;
  }
  return childRuntime;
}

function isUsefulChildRuntimeConfidence(confidence) {
  return confidence === 'medium' || confidence === 'high' || confidence === 'explicit';
}

function formatChildRuntimeEvidence(code) {
  switch (code) {
    case 'explicit_header_parent':
      return 'header parent';
    case 'inherited_deck_runtime':
      return 'deck env';
    case 'process_ancestor_match':
      return 'process ancestor';
    case 'started_during_parent_tool':
      return 'parent tool';
    case 'same_terminal':
      return 'same terminal';
    case 'headless_in_memory':
      return 'headless in-memory';
    case 'automation_input_source':
      return 'automation input';
    default:
      return String(code).replaceAll('_', ' ');
  }
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

function getRowActivityLabel(record) {
  if (record.presenceState !== 'live') {
    return record.presenceState;
  }

  const activity = getActivityDisplay(record);
  return activity.label === 'idle' ? 'live' : activity.label;
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

function createDetailValue(text, linkHref, middleTruncateTail) {
  const value = document.createElement(linkHref ? 'a' : 'div');
  value.className = linkHref ? 'detail-value detail-link' : 'detail-value';

  if (middleTruncateTail === null || text.length <= middleTruncateTail) {
    value.textContent = text;
  } else {
    value.classList.add('detail-value-middle');
    value.setAttribute('title', text);
    const { head, tail } = splitMiddleText(text, middleTruncateTail);
    value.append(
      createText('span', head, 'detail-value-head'),
      createText('span', tail, 'detail-value-tail'),
    );
  }

  if (linkHref) {
    value.setAttribute('href', linkHref);
    value.setAttribute('target', '_blank');
    value.setAttribute('rel', 'noreferrer');
    value.addEventListener('click', (event) => {
      event.preventDefault();
      window.open(linkHref, '_blank', 'noopener,noreferrer');
    });
  }

  return value;
}

function splitMiddleText(text, tailLength) {
  return {
    head: text.slice(0, -tailLength),
    tail: text.slice(-tailLength),
  };
}

function createChip(text, className = 'chip') {
  return createText('span', text, className);
}

function isObject(candidate) {
  return typeof candidate === 'object' && candidate !== null;
}

init();

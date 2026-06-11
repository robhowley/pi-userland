/* global Headers, URLSearchParams, document, fetch, navigator, setInterval, window */

const state = {
  currentCwd: '',
  messageEl: document.getElementById('message'),
  cwdNoteEl: document.getElementById('cwd-note'),
  compactStatusEl: document.getElementById('compact-status'),
  watchListEl: document.getElementById('watch-list'),
  watchUiLayoutEl: document.getElementById('watch-ui-layout'),
  transcriptPanelEl: document.getElementById('transcript-panel'),
  transcriptTitleEl: document.getElementById('transcript-title'),
  transcriptStatusEl: document.getElementById('transcript-status'),
  transcriptMetaEl: document.getElementById('transcript-meta'),
  transcriptCloseEl: document.getElementById('transcript-close'),
  transcriptBodyEl: document.getElementById('transcript-body'),
  transcriptContentEl: document.getElementById('transcript-content'),
  token: '',
  urlInput: document.getElementById('watch-url'),
  watches: [],
  selectedWatchId: '',
  selectedTranscriptWatchId: '',
  selectedTranscriptStatus: 'idle',
  selectedTranscriptRows: [],
  selectedTranscriptError: '',
  selectedTranscriptMissing: false,
  selectedTranscriptRefreshing: false,
  selectedTranscriptLoadedForWatchUpdatedAt: '',
  selectedTranscriptRequestedForWatchUpdatedAt: '',
  selectedTranscriptRequestId: 0,
  selectedTranscriptWatchSnapshot: null,
  selectedTranscriptTail: 120,
  lastTranscriptContentSignature: '',
};

const hashParams = new URLSearchParams(window.location.hash.replace(/^#/, ''));
state.token = hashParams.get('token') ?? '';
state.currentCwd = hashParams.get('cwd') ?? '';

const form = document.getElementById('add-watch-form');
form?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const url = state.urlInput?.value.trim() ?? '';
  if (!url) {
    setMessage('Enter a GitHub pull request URL.', 'warning');
    return;
  }

  try {
    const response = await api('/api/watches', {
      method: 'POST',
      body: JSON.stringify({
        url,
        ...(state.currentCwd ? { cwd: state.currentCwd } : {}),
      }),
    });
    setMessage(
      response.message ?? (response.created ? 'Watch added.' : 'Watch already exists.'),
      response.created ? 'info' : 'warning',
    );
    if (response.created && state.urlInput) {
      state.urlInput.value = '';
    }
    await refreshWatches();
  } catch (error) {
    setMessage(readErrorMessage(error), 'error');
  }
});

state.transcriptCloseEl?.addEventListener('click', () => {
  clearSelectedTranscript();
});

ensureCompactStatusElement();
renderCompactStatus([]);
renderWatches([]);
renderTranscriptPanel();
void refreshWatches();
setInterval(() => {
  void refreshWatches();
}, 3_000);

async function refreshWatches() {
  if (!state.token) {
    setMessage('Missing merge-ready watch UI token in the URL hash.', 'error');
    return;
  }

  try {
    const payload = await api('/api/watches');
    if (!state.currentCwd && typeof payload.defaultCwd === 'string') {
      state.currentCwd = payload.defaultCwd;
    }

    state.watches = sortWatchesByAttention(Array.isArray(payload.watches) ? payload.watches : []);
    ensureSelectedWatch();
    renderCwdNote(payload.defaultCwd);
    renderCompactStatus(state.watches);
    reconcileSelectedTranscriptWithWatches();
    renderWatches(state.watches);
    renderTranscriptPanel({ preserveScroll: Boolean(state.selectedTranscriptWatchId) });

    const selectedWatch = findWatchById(state.selectedTranscriptWatchId);
    if (shouldRefreshSelectedTranscript(selectedWatch)) {
      void loadSelectedTranscript({ watch: selectedWatch, refresh: true });
    }
  } catch (error) {
    setMessage(readErrorMessage(error), 'error');
  }
}

async function api(pathname, options = {}) {
  const headers = new Headers(options.headers ?? {});
  headers.set('Authorization', `Bearer ${state.token}`);
  if (options.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  const response = await fetch(pathname, {
    ...options,
    headers,
  });

  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(
      typeof payload.error === 'string'
        ? payload.error
        : `Request failed with ${String(response.status)}`,
    );
  }

  return payload;
}

function ensureCompactStatusElement() {
  if (state.compactStatusEl) {
    return;
  }

  const shell = document.querySelector('.shell');
  const main = document.querySelector('main');
  if (!shell || !main) {
    return;
  }

  const compactStatus = createElement('div', 'compact-status');
  compactStatus.id = 'compact-status';
  compactStatus.setAttribute('aria-label', 'Watch summary');
  main.insertBefore(compactStatus, shell);
  state.compactStatusEl = compactStatus;
}

function renderCwdNote(defaultCwd) {
  if (!state.cwdNoteEl) {
    return;
  }

  const effectiveCwd = state.currentCwd || defaultCwd || '(unknown cwd)';
  state.cwdNoteEl.textContent = `New watches use cwd: ${effectiveCwd}`;
}

function renderCompactStatus(watches) {
  if (!state.compactStatusEl) {
    return;
  }

  const counts = readWatchCounts(watches);
  state.compactStatusEl.replaceChildren(
    renderStatusStat(counts.total, 'watches'),
    renderStatusStat(counts.needsUser, 'needs user', 'bad'),
    renderStatusStat(counts.activeLoops, 'active loops', 'good'),
    renderStatusStat(counts.waiting, 'waiting', 'warn'),
    renderStatusStat(counts.ready, 'ready', 'good'),
  );
}

function renderStatusStat(value, label, tone = '') {
  const item = document.createElement('span');
  const strong = createElement('strong', tone, String(value));
  item.append(strong, ` ${label}`);
  return item;
}

function renderWatches(watches) {
  if (!state.watchListEl) {
    return;
  }

  state.watchListEl.replaceChildren();
  if (watches.length === 0) {
    const empty = createElement('p', 'empty-state', 'No watches yet.');
    state.watchListEl.append(empty);
    return;
  }

  const consoleEl = createElement('section', 'watch-console');
  const queue = renderWatchQueue(watches);
  const selectedWatch = findWatchById(state.selectedWatchId) ?? watches[0] ?? null;
  const detail = renderSelectedWatchDetail(selectedWatch);
  consoleEl.append(queue, detail);
  state.watchListEl.append(consoleEl);
}

function renderWatchQueue(watches) {
  const queue = createElement('nav', 'queue');
  queue.setAttribute('aria-label', 'Tracked pull requests');

  const head = createElement('div', 'queue-head');
  head.append(
    createElement('span', '', 'Tracked PRs'),
    createElement('strong', '', 'attention first'),
  );
  queue.append(head);

  for (const watch of watches) {
    queue.append(renderWatchRow(watch));
  }

  return queue;
}

function renderWatchRow(watch) {
  const row = document.createElement('div');
  row.className = 'watch-row';
  row.dataset.watchId = watch.id;
  row.tabIndex = 0;
  row.setAttribute('role', 'button');
  row.setAttribute('aria-label', `Select ${readWatchLabel(watch)}`);
  if (watch.id === state.selectedWatchId) {
    row.classList.add('selected');
  }

  const select = () => {
    state.selectedWatchId = watch.id;
    renderWatches(state.watches);
  };
  row.addEventListener('click', select);
  row.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      select();
    }
  });

  const dot = createElement('span', `dot ${readWatchTone(watch)}`);
  const main = createElement('span', 'row-main');
  main.append(
    createElement('span', 'repo', readWatchLabel(watch)),
    createElement('span', 'row-title', readWatchTitle(watch)),
    renderWatchRowMeta(watch),
  );
  row.append(dot, main, createElement('span', 'age', shortAge(watch.updatedAt)));
  return row;
}

function renderWatchRowMeta(watch) {
  const meta = createElement('span', 'row-meta');
  meta.append(
    createPrLink(watch, 'PR ↗'),
    createElement('span', `pill ${readWatchTone(watch)}`, readWatchLifecycle(watch)),
    createElement('span', 'pill', readWatchMergeState(watch)),
    createElement('span', '', readWatchQueueReason(watch)),
  );
  return meta;
}

function renderSelectedWatchDetail(watch) {
  const detail = createElement('section', 'detail detail-compact');
  detail.setAttribute('aria-label', 'Selected watch detail');

  if (!watch) {
    detail.append(createElement('p', 'empty-state', 'Select a watch to inspect it.'));
    return detail;
  }

  const top = createElement('div', 'detail-top');
  const stateLine = createElement('div', 'state-line');
  stateLine.append(
    createPrLink(watch, 'Open PR'),
    createElement('span', `badge ${readWatchTone(watch)}`, readWatchLifecycle(watch)),
    createElement('span', 'badge secondary', readWatchMergeState(watch)),
  );
  top.append(stateLine, renderWatchActions(watch));

  const primary = createElement('div', 'detail-primary');
  primary.append(
    top,
    createElement('h3', 'state-title', readSelectedWatchHeadline(watch)),
    renderSelectedWatchMeta(watch),
  );

  const body = createElement('div', 'detail-body');
  const inspector = createElement('div', 'inspector');
  inspector.append(renderWatchReason(watch), renderWatchFacts(watch));

  body.append(inspector);
  detail.append(primary, body, renderWatchTimeline(watch));
  return detail;
}

function renderSelectedWatchMeta(watch) {
  const meta = createElement('div', 'detail-meta');
  meta.append(
    createElement('span', '', readWatchLabel(watch)),
    createElement('span', '', shortAge(watch.updatedAt)),
  );
  return meta;
}

function renderWatchReason(watch) {
  const reason = createElement('div', 'reason-card');
  reason.append(
    createElement('div', 'reason-label', 'Current read'),
    createElement('div', 'reason-text', readWatchOpenItem(watch)),
  );

  const summary = readWatchSummary(watch);
  const headline = readSelectedWatchHeadline(watch);
  if (summary && summary !== headline && !summary.includes(watch.canonicalUrl ?? '')) {
    reason.append(
      createElement('div', 'reason-label secondary-label', 'Last message'),
      createElement('div', 'reason-text muted', summary),
    );
  }

  return reason;
}

function renderWatchFacts(watch) {
  const details = createElement('dl', 'facts facts-with-actions');
  const sessionId = watch.session?.sessionId ?? '';
  const sessionFile = watch.session?.sessionFile ?? '';

  appendDefinition(details, 'Updated', formatAge(watch.updatedAt));
  appendDefinition(details, 'Lifecycle', readWatchLifecycle(watch), readWatchTone(watch));
  appendDefinition(details, 'Merge state', readWatchMergeState(watch));
  appendDefinition(details, 'Cwd', watch.cwd ?? '(unknown cwd)');
  appendDefinition(details, 'PR', readWatchPrDisplay(watch));
  appendCopyDefinition(details, 'Session', shortenSessionId(sessionId), sessionId);
  appendCopyDefinition(details, 'File', shortenSessionFile(sessionFile), sessionFile);
  return details;
}

function appendDefinition(dl, term, value, tone = '') {
  dl.append(createElement('dt', '', term), createElement('dd', tone, value));
}

function appendCopyDefinition(dl, term, displayValue, copyValue) {
  const value = typeof copyValue === 'string' ? copyValue : '';
  const display = displayValue || '(none)';
  const dd = createElement('dd', 'copy-fact');
  const text = createElement('span', 'copy-fact-value', display);
  text.title = value || display;
  const copy = createButton('copy', !value, async () => {
    await copyText(value);
  });
  dd.append(text, copy);
  dl.append(createElement('dt', '', term), dd);
}

function readWatchPrDisplay(watch) {
  const url = typeof watch.canonicalUrl === 'string' ? watch.canonicalUrl : '';
  const match = /github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(url);
  if (!match) {
    return url || '(unknown PR URL)';
  }

  return `${match[1]}/${match[2]} #${match[3]}`;
}

function shortenSessionId(value) {
  if (typeof value !== 'string' || value.length === 0) {
    return '(unknown)';
  }

  if (value.length <= 28) {
    return value;
  }

  return `${value.slice(0, 12)}…${value.slice(-8)}`;
}

function shortenSessionFile(value) {
  if (typeof value !== 'string' || value.length === 0) {
    return '(none)';
  }

  const filename = value.split('/').filter(Boolean).pop() ?? value;
  if (filename.length <= 44) {
    return filename;
  }

  return `${filename.slice(0, 32)}…${filename.slice(-8)}`;
}

function renderWatchTimeline(watch) {
  const timeline = createElement('div', 'timeline');
  timeline.setAttribute('aria-label', 'Recent watch events');
  timeline.append(createElement('div', 'timeline-head', 'Recent events'));

  const events = readWatchEvents(watch);
  for (const event of events) {
    const row = createElement('div', 'event');
    row.append(createElement('time', '', event.time), createElement('span', '', event.text));
    timeline.append(row);
  }

  return timeline;
}

function renderWatchActions(watch) {
  const actions = createElement('div', 'actions');
  actions.setAttribute('aria-label', 'Watch actions');

  const stopButton = createButton('Stop', watch.state !== 'active', async () => {
    try {
      await api(`/api/watches/${encodeURIComponent(watch.id)}/stop`, { method: 'POST' });
      setMessage('Watch stopped.', 'info');
      await refreshWatches();
    } catch (error) {
      setMessage(readErrorMessage(error), 'error');
    }
  });

  const transcriptButton = createButton(
    watch.id === state.selectedTranscriptWatchId ? 'Hide transcript' : 'Transcript',
    false,
    () => {
      toggleTranscriptSelection(watch);
    },
  );

  const removeButton = createButton('Remove', watch.state === 'active', async () => {
    try {
      await api(`/api/watches/${encodeURIComponent(watch.id)}`, { method: 'DELETE' });
      if (watch.id === state.selectedTranscriptWatchId) {
        clearSelectedTranscript();
      }
      if (watch.id === state.selectedWatchId) {
        state.selectedWatchId = '';
      }
      setMessage('Watch removed.', 'info');
      await refreshWatches();
    } catch (error) {
      setMessage(readErrorMessage(error), 'error');
    }
  });
  removeButton.classList.add('danger');

  actions.append(stopButton, transcriptButton, removeButton);
  return actions;
}

async function copyText(value) {
  try {
    if (!navigator?.clipboard?.writeText) {
      throw new Error('Clipboard API unavailable.');
    }
    await navigator.clipboard.writeText(value);
    setMessage('Copied.', 'info');
  } catch (error) {
    setMessage(readErrorMessage(error), 'warning');
  }
}

function renderTranscriptPanel(options = {}) {
  const { preserveScroll = false } = options;

  if (
    !state.transcriptPanelEl ||
    !state.transcriptTitleEl ||
    !state.transcriptStatusEl ||
    !state.transcriptMetaEl ||
    !state.transcriptCloseEl ||
    !state.transcriptBodyEl ||
    !state.transcriptContentEl
  ) {
    return;
  }

  const hasSelection = Boolean(state.selectedTranscriptWatchId);
  const snapshot = state.selectedTranscriptWatchSnapshot;
  if (state.watchUiLayoutEl) {
    state.watchUiLayoutEl.dataset.hasSelection = hasSelection ? 'true' : 'false';
  }
  state.transcriptPanelEl.hidden = !hasSelection;
  state.transcriptPanelEl.setAttribute('aria-hidden', hasSelection ? 'false' : 'true');
  state.transcriptPanelEl.dataset.state = readTranscriptPanelState();
  state.transcriptPanelEl.dataset.selected = hasSelection ? 'true' : 'false';
  state.transcriptTitleEl.textContent = 'Transcript';
  state.transcriptStatusEl.textContent = readTranscriptStatusText();
  state.transcriptMetaEl.textContent = hasSelection
    ? readTranscriptMetaText(snapshot)
    : 'Select a watch to inspect its transcript.';
  state.transcriptCloseEl.disabled = !hasSelection;

  const contentSignature = readTranscriptContentSignature();
  if (contentSignature === state.lastTranscriptContentSignature) {
    return;
  }

  const scrollState = preserveScroll ? captureTranscriptScrollState() : null;
  state.transcriptContentEl.replaceChildren(...buildTranscriptContentNodes());
  state.lastTranscriptContentSignature = contentSignature;

  if (scrollState) {
    restoreTranscriptScrollState(scrollState);
  }
}

function buildTranscriptContentNodes() {
  if (!state.selectedTranscriptWatchId) {
    return [createElement('p', 'empty-state', 'Select a watch to inspect its transcript.')];
  }

  const nodes = [];

  if (state.selectedTranscriptMissing) {
    nodes.push(
      createElement(
        'p',
        'transcript-meta',
        'Watch no longer present in registry. Close transcript or select another watch.',
      ),
    );
  }

  if (state.selectedTranscriptError) {
    nodes.push(createElement('p', 'transcript-meta', state.selectedTranscriptError));
  }

  if (
    !state.selectedTranscriptMissing &&
    state.selectedTranscriptStatus === 'loading' &&
    state.selectedTranscriptRows.length === 0
  ) {
    nodes.push(createElement('p', 'transcript-meta', 'Loading transcript…'));
    return nodes;
  }

  if (state.selectedTranscriptMissing && state.selectedTranscriptRows.length === 0) {
    return nodes;
  }

  if (state.selectedTranscriptStatus === 'error' && state.selectedTranscriptRows.length === 0) {
    if (nodes.length === 0) {
      nodes.push(createElement('p', 'transcript-meta', 'Transcript unavailable.'));
    }
    return nodes;
  }

  nodes.push(
    createElement(
      'p',
      'transcript-meta',
      `Transcript tail (${String(state.selectedTranscriptRows.length)} rows)`,
    ),
    renderTranscriptRows(state.selectedTranscriptRows),
  );
  return nodes;
}

function renderTranscriptRows(rows) {
  const container = createElement('div', 'transcript-rows');
  if (rows.length === 0) {
    container.append(createElement('p', 'transcript-meta', 'No transcript rows found.'));
    return container;
  }

  for (const row of rows) {
    const entry = createElement('div', 'transcript-row');
    const header = createElement('div', 'transcript-row-header');
    header.append(
      createElement('strong', '', `${row?.label ?? 'Row'}`),
      createElement('span', 'muted', formatTimestamp(row?.timestamp)),
    );
    const text = createElement(
      'pre',
      'transcript-row-text',
      typeof row?.text === 'string' && row.text.length > 0 ? row.text : '(empty)',
    );
    entry.append(header, text);
    container.append(entry);
  }

  return container;
}

function toggleTranscriptSelection(watch) {
  if (watch.id === state.selectedTranscriptWatchId) {
    clearSelectedTranscript();
    return;
  }

  selectTranscriptWatch(watch);
}

function selectTranscriptWatch(watch) {
  state.selectedTranscriptWatchId = watch.id;
  state.selectedWatchId = watch.id;
  state.selectedTranscriptWatchSnapshot = watch;
  state.selectedTranscriptStatus = 'loading';
  state.selectedTranscriptRows = [];
  state.selectedTranscriptError = '';
  state.selectedTranscriptMissing = false;
  state.selectedTranscriptRefreshing = false;
  state.selectedTranscriptLoadedForWatchUpdatedAt = '';
  state.selectedTranscriptRequestedForWatchUpdatedAt = '';

  renderWatches(state.watches);
  renderTranscriptPanel();
  resetTranscriptScroll();
  scrollTranscriptPanelIntoView();
  void loadSelectedTranscript({ watch, refresh: false });
}

function clearSelectedTranscript() {
  if (!state.selectedTranscriptWatchId && state.selectedTranscriptStatus === 'idle') {
    return;
  }

  state.selectedTranscriptWatchId = '';
  state.selectedTranscriptStatus = 'idle';
  state.selectedTranscriptRows = [];
  state.selectedTranscriptError = '';
  state.selectedTranscriptMissing = false;
  state.selectedTranscriptRefreshing = false;
  state.selectedTranscriptLoadedForWatchUpdatedAt = '';
  state.selectedTranscriptRequestedForWatchUpdatedAt = '';
  state.selectedTranscriptWatchSnapshot = null;
  state.selectedTranscriptRequestId += 1;

  renderWatches(state.watches);
  renderTranscriptPanel();
  resetTranscriptScroll();
}

async function loadSelectedTranscript(options = {}) {
  const { watch = state.selectedTranscriptWatchSnapshot, refresh = false } = options;

  if (!watch || !state.selectedTranscriptWatchId) {
    return;
  }

  const watchId = watch.id;
  const watchUpdatedAt = typeof watch.updatedAt === 'string' ? watch.updatedAt : '';
  const requestId = state.selectedTranscriptRequestId + 1;
  const keepRowsVisible = refresh && state.selectedTranscriptRows.length > 0;

  state.selectedTranscriptRequestId = requestId;
  state.selectedTranscriptRequestedForWatchUpdatedAt = watchUpdatedAt;
  state.selectedTranscriptWatchSnapshot = watch;
  state.selectedTranscriptMissing = false;

  if (keepRowsVisible) {
    state.selectedTranscriptRefreshing = true;
    state.selectedTranscriptError = '';
  } else {
    state.selectedTranscriptStatus = 'loading';
    state.selectedTranscriptRows = [];
    state.selectedTranscriptError = '';
    state.selectedTranscriptRefreshing = false;
  }

  renderTranscriptPanel({ preserveScroll: keepRowsVisible });

  try {
    const payload = await api(
      `/api/watches/${encodeURIComponent(watchId)}/transcript?tail=${String(state.selectedTranscriptTail)}`,
    );
    if (
      requestId !== state.selectedTranscriptRequestId ||
      state.selectedTranscriptWatchId !== watchId
    ) {
      return;
    }

    state.selectedTranscriptStatus = 'ready';
    state.selectedTranscriptRows = Array.isArray(payload.rows) ? payload.rows : [];
    state.selectedTranscriptError = '';
    state.selectedTranscriptMissing = false;
    state.selectedTranscriptRefreshing = false;
    state.selectedTranscriptLoadedForWatchUpdatedAt = watchUpdatedAt;
    state.selectedTranscriptRequestedForWatchUpdatedAt = watchUpdatedAt;

    const currentWatch = findWatchById(watchId);
    if (currentWatch) {
      state.selectedTranscriptWatchSnapshot = currentWatch;
    }

    renderTranscriptPanel({ preserveScroll: keepRowsVisible });
  } catch (error) {
    if (
      requestId !== state.selectedTranscriptRequestId ||
      state.selectedTranscriptWatchId !== watchId
    ) {
      return;
    }

    state.selectedTranscriptStatus = 'error';
    state.selectedTranscriptError = readErrorMessage(error);
    state.selectedTranscriptRefreshing = false;
    state.selectedTranscriptRequestedForWatchUpdatedAt = '';
    renderTranscriptPanel({ preserveScroll: keepRowsVisible });
  }
}

function reconcileSelectedTranscriptWithWatches() {
  if (!state.selectedTranscriptWatchId) {
    return;
  }

  const selectedWatch = findWatchById(state.selectedTranscriptWatchId);
  if (selectedWatch) {
    state.selectedTranscriptWatchSnapshot = selectedWatch;
    state.selectedTranscriptMissing = false;
    return;
  }

  if (!state.selectedTranscriptMissing) {
    state.selectedTranscriptRequestId += 1;
  }

  state.selectedTranscriptMissing = true;
  state.selectedTranscriptError = '';
  state.selectedTranscriptRefreshing = false;
  state.selectedTranscriptRequestedForWatchUpdatedAt = '';
  if (state.selectedTranscriptRows.length === 0) {
    state.selectedTranscriptStatus = 'error';
  }
}

function shouldRefreshSelectedTranscript(watch) {
  if (!watch || !state.selectedTranscriptWatchId) {
    return false;
  }

  if (state.selectedTranscriptStatus === 'loading' || state.selectedTranscriptRefreshing) {
    return false;
  }

  const watchUpdatedAt = typeof watch.updatedAt === 'string' ? watch.updatedAt : '';
  if (!watchUpdatedAt) {
    return false;
  }

  return watchUpdatedAt !== state.selectedTranscriptLoadedForWatchUpdatedAt;
}

function ensureSelectedWatch() {
  if (state.watches.length === 0) {
    state.selectedWatchId = '';
    return;
  }

  if (!findWatchById(state.selectedWatchId)) {
    state.selectedWatchId = state.watches[0].id;
  }
}

function findWatchById(watchId) {
  if (!watchId) {
    return null;
  }

  return state.watches.find((watch) => watch.id === watchId) ?? null;
}

function readTranscriptPanelState() {
  if (!state.selectedTranscriptWatchId) {
    return 'empty';
  }

  if (state.selectedTranscriptMissing) {
    return 'missing';
  }

  if (state.selectedTranscriptRefreshing) {
    return 'refreshing';
  }

  return state.selectedTranscriptStatus;
}

function readTranscriptStatusText() {
  if (!state.selectedTranscriptWatchId) {
    return 'Select a watch';
  }

  if (state.selectedTranscriptMissing) {
    return 'Watch missing';
  }

  if (state.selectedTranscriptRefreshing) {
    return 'Refreshing…';
  }

  if (state.selectedTranscriptStatus === 'loading') {
    return 'Loading…';
  }

  if (state.selectedTranscriptStatus === 'error') {
    return state.selectedTranscriptRows.length > 0 ? 'Refresh failed' : 'Error';
  }

  return 'Ready';
}

function readTranscriptMetaText(watch) {
  if (!watch) {
    return 'Select a watch.';
  }

  return `${readWatchLabel(watch)} · updated ${formatAge(watch.updatedAt)}`;
}

function readTranscriptContentSignature() {
  if (!state.selectedTranscriptWatchId) {
    return 'empty';
  }

  return JSON.stringify({
    watchId: state.selectedTranscriptWatchId,
    missing: state.selectedTranscriptMissing,
    error: state.selectedTranscriptError,
    loading:
      !state.selectedTranscriptMissing &&
      state.selectedTranscriptStatus === 'loading' &&
      state.selectedTranscriptRows.length === 0,
    rows: state.selectedTranscriptRows.map((row) => [
      row?.label ?? '',
      row?.timestamp ?? '',
      row?.text ?? '',
    ]),
  });
}

function captureTranscriptScrollState() {
  if (!state.transcriptBodyEl) {
    return null;
  }

  const distanceFromBottom =
    state.transcriptBodyEl.scrollHeight -
    state.transcriptBodyEl.clientHeight -
    state.transcriptBodyEl.scrollTop;

  return {
    nearBottom: distanceFromBottom <= 24,
    scrollTop: state.transcriptBodyEl.scrollTop,
  };
}

function restoreTranscriptScrollState(scrollState) {
  if (!state.transcriptBodyEl || !scrollState) {
    return;
  }

  if (scrollState.nearBottom) {
    state.transcriptBodyEl.scrollTop = state.transcriptBodyEl.scrollHeight;
    return;
  }

  const maxScrollTop = Math.max(
    0,
    state.transcriptBodyEl.scrollHeight - state.transcriptBodyEl.clientHeight,
  );
  state.transcriptBodyEl.scrollTop = Math.min(scrollState.scrollTop, maxScrollTop);
}

function resetTranscriptScroll() {
  if (!state.transcriptBodyEl) {
    return;
  }

  state.transcriptBodyEl.scrollTop = 0;
}

function scrollTranscriptPanelIntoView() {
  if (!state.transcriptPanelEl || typeof state.transcriptPanelEl.scrollIntoView !== 'function') {
    return;
  }

  const isNarrow =
    typeof window.matchMedia === 'function'
      ? window.matchMedia('(max-width: 959px)').matches
      : window.innerWidth <= 959;
  if (!isNarrow) {
    return;
  }

  state.transcriptPanelEl.scrollIntoView({ block: 'start' });
}

function createPrLink(watch, label = 'PR ↗') {
  const url =
    typeof watch?.canonicalUrl === 'string'
      ? watch.canonicalUrl
      : (watch?.lastStatus?.pr?.url ?? '');
  const link = document.createElement('a');
  link.className = 'pr-link';
  link.href = url || '#';
  link.target = '_blank';
  link.rel = 'noreferrer';
  link.textContent = label;
  link.title = url || 'Pull request URL unavailable';
  if (!url) {
    link.setAttribute('aria-disabled', 'true');
    link.tabIndex = -1;
  }
  link.addEventListener('click', (event) => {
    event.stopPropagation();
    if (!url) {
      event.preventDefault();
    }
  });
  return link;
}

function createButton(label, disabled, onClick) {
  const button = document.createElement('button');
  button.type = 'button';
  button.disabled = disabled;
  button.textContent = label;
  button.addEventListener('click', () => {
    void onClick();
  });
  return button;
}

function createElement(tagName, className, text) {
  const element = document.createElement(tagName);
  if (className) {
    element.className = className;
  }
  if (text !== undefined) {
    element.textContent = text;
  }
  return element;
}

function sortWatchesByAttention(watches) {
  return [...watches].sort((a, b) => {
    const priorityDiff = readWatchPriority(a) - readWatchPriority(b);
    if (priorityDiff !== 0) {
      return priorityDiff;
    }

    return readTimestampValue(b.updatedAt) - readTimestampValue(a.updatedAt);
  });
}

function readWatchPriority(watch) {
  const lifecycle = readWatchLifecycle(watch);
  const mergeState = readWatchMergeState(watch);
  const summary = readWatchSummary(watch).toLowerCase();

  if (watch.state === 'error' || watch.state === 'stale' || lifecycle === 'stopped') {
    return 0;
  }

  if (
    summary.includes('needs user') ||
    summary.includes('manual') ||
    summary.includes('ambiguous')
  ) {
    return 1;
  }

  if (['repairing', 'verifying', 'active'].includes(lifecycle) || watch.state === 'active') {
    return 2;
  }

  if (mergeState === 'blocked') {
    return 3;
  }

  if (mergeState === 'pending' || lifecycle === 'waiting') {
    return 4;
  }

  if (mergeState === 'ready') {
    return 5;
  }

  return 6;
}

function readWatchCounts(watches) {
  const counts = {
    total: watches.length,
    needsUser: 0,
    activeLoops: 0,
    waiting: 0,
    ready: 0,
  };

  for (const watch of watches) {
    const priority = readWatchPriority(watch);
    const lifecycle = readWatchLifecycle(watch);
    const mergeState = readWatchMergeState(watch);
    if (priority <= 1) {
      counts.needsUser += 1;
    } else if (
      ['repairing', 'verifying', 'active'].includes(lifecycle) ||
      watch.state === 'active'
    ) {
      counts.activeLoops += 1;
    } else if (mergeState === 'pending' || lifecycle === 'waiting') {
      counts.waiting += 1;
    } else if (mergeState === 'ready') {
      counts.ready += 1;
    }
  }

  return counts;
}

function readWatchTone(watch) {
  const priority = readWatchPriority(watch);
  const mergeState = readWatchMergeState(watch);

  if (mergeState === 'ready') {
    return 'good';
  }

  if (priority <= 1 || mergeState === 'blocked' || watch.state === 'error') {
    return 'bad';
  }

  if (
    mergeState === 'pending' ||
    ['repairing', 'verifying', 'active', 'waiting'].includes(readWatchLifecycle(watch))
  ) {
    return 'warn';
  }

  return 'pending';
}

function readWatchLifecycle(watch) {
  if (watch.state === 'stale') {
    return 'stale';
  }

  return watch.lastStatus?.lifecycle ?? watch.state ?? 'unknown';
}

function readWatchMergeState(watch) {
  if (watch.state === 'stale') {
    return 'unknown';
  }

  return watch.lastStatus?.mergeReadyState ?? 'unknown';
}

function readWatchSummary(watch) {
  if (watch.state === 'stale') {
    return 'Supervisor restarted before this watch could be reattached.';
  }

  return watch.lastStatus?.summary ?? watch.lastError ?? 'No status yet.';
}

function readWatchOpenItem(watch) {
  const item = watch.lastStatus?.openItems?.[0];
  if (item?.summary) {
    return item.summary;
  }

  const mergeState = readWatchMergeState(watch);
  if (mergeState === 'unknown') {
    return 'unknown because no current status was produced';
  }

  if (mergeState === 'ready') {
    return 'none';
  }

  return readWatchSummary(watch);
}

function readSelectedWatchHeadline(watch) {
  const lifecycle = readWatchLifecycle(watch);
  const mergeState = readWatchMergeState(watch);
  const summary = readWatchSummary(watch);

  if (lifecycle === 'stopped' && mergeState === 'unknown') {
    return 'Watcher stopped before producing a current merge signal.';
  }

  if (watch.state === 'stale') {
    return 'Supervisor restarted before this watch could be reattached.';
  }

  if (mergeState === 'ready') {
    return 'PR is ready from the latest watcher signal.';
  }

  if (mergeState === 'blocked') {
    return 'PR is blocked by the latest merge-ready signal.';
  }

  if (mergeState === 'pending') {
    return 'Watcher is waiting on a pending merge-ready signal.';
  }

  return summary;
}

function readWatchQueueReason(watch) {
  const lifecycle = readWatchLifecycle(watch);
  const mergeState = readWatchMergeState(watch);

  if (watch.state === 'stale' || lifecycle === 'stopped' || watch.state === 'error') {
    return 'needs inspection';
  }

  if (['repairing', 'verifying', 'active'].includes(lifecycle) || watch.state === 'active') {
    return 'agent running';
  }

  if (mergeState === 'pending' || lifecycle === 'waiting') {
    return 'no action';
  }

  if (mergeState === 'ready') {
    return 'no open items';
  }

  if (mergeState === 'blocked') {
    return 'actionable';
  }

  return 'polling';
}

function readWatchTitle(watch) {
  const title = watch.lastStatus?.pr?.title;
  if (typeof title === 'string' && title.trim()) {
    return title.trim();
  }

  return stripGithubPullUrl(readWatchSummary(watch)) || readSelectedWatchHeadline(watch);
}

function stripGithubPullUrl(text) {
  if (typeof text !== 'string') {
    return '';
  }

  return text
    .replace(/https:\/\/github\.com\/[^\s]+\/[^\s]+\/pull\/\d+/g, '')
    .replace(/\s+for\s*$/i, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function readWatchLabel(watch) {
  const url = watch.canonicalUrl ?? watch.lastStatus?.pr?.url ?? '';
  const match = url.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (match) {
    return `${match[1]}/${match[2]} #${match[3]}`;
  }

  return url || '(unknown PR)';
}

function readWatchEvents(watch) {
  return [
    {
      time: shortAge(watch.createdAt ?? watch.updatedAt),
      text: 'watch registered',
    },
    {
      time: shortAge(watch.updatedAt),
      text: stripGithubPullUrl(readWatchSummary(watch)) || readSelectedWatchHeadline(watch),
    },
  ];
}

function readTimestampValue(timestamp) {
  if (typeof timestamp !== 'string') {
    return 0;
  }

  const value = new Date(timestamp).getTime();
  return Number.isFinite(value) ? value : 0;
}

function shortAge(timestamp) {
  const age = formatAge(timestamp);
  return age.replace(/ ago$/, '');
}

function formatAge(timestamp) {
  if (typeof timestamp !== 'string') {
    return 'unknown';
  }

  const value = new Date(timestamp).getTime();
  if (!Number.isFinite(value)) {
    return timestamp;
  }

  const diffSeconds = Math.max(0, Math.round((Date.now() - value) / 1000));
  if (diffSeconds < 60) {
    return `${String(diffSeconds)}s ago`;
  }

  const diffMinutes = Math.round(diffSeconds / 60);
  if (diffMinutes < 60) {
    return `${String(diffMinutes)}m ago`;
  }

  const diffHours = Math.round(diffMinutes / 60);
  return `${String(diffHours)}h ago`;
}

function formatTimestamp(timestamp) {
  if (typeof timestamp !== 'string') {
    return 'unknown';
  }

  const value = new Date(timestamp);
  return Number.isNaN(value.getTime()) ? timestamp : value.toLocaleString();
}

function setMessage(text, tone = 'info') {
  if (!state.messageEl) {
    return;
  }

  state.messageEl.dataset.tone = tone;
  state.messageEl.textContent = text;
}

function readErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

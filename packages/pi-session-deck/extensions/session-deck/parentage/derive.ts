import type {
  ActivityInputSummary,
  ActivityToolWindow,
  SessionDeckRecord,
} from '../activity/types.js';
import type {
  ChildRuntimeConfidence,
  ChildRuntimeEvidence,
  ChildRuntimeEvidenceCode,
  ChildRuntimeFacet,
  SessionRowKindFacet,
  SessionRuntimeProcessAncestorMetadata,
  SessionTerminalMetadata,
} from '../identity/types.js';

const CONFIDENCE_WEIGHT: Record<ChildRuntimeConfidence, number> = {
  none: 0,
  unknown: 0,
  low: 1,
  medium: 2,
  high: 3,
  explicit: 4,
};

const TOOL_TIMING_SUPPORT_CODES = new Set<ChildRuntimeEvidenceCode>([
  'inherited_deck_runtime',
  'process_ancestor_match',
  'same_terminal',
  'headless_in_memory',
]);

interface ParentageIndexes {
  byRuntimeId: Map<string, SessionDeckRecord>;
  bySessionId: Map<string, SessionDeckRecord[]>;
  bySessionFile: Map<string, SessionDeckRecord[]>;
  byHeaderId: Map<string, SessionDeckRecord[]>;
  byProcessPid: Map<number, SessionDeckRecord[]>;
}

interface ParentResolution {
  parentRuntimeId?: string;
  parentSessionId?: string;
  conflicted: boolean;
}

export function attachChildRuntimeFacets<T extends SessionDeckRecord>(records: readonly T[]): T[] {
  const facets = deriveChildRuntimeFacets(records);
  return records.map((record) => {
    if (record.derivedFacets === undefined) {
      return record;
    }

    const childRuntime = facets.get(record.runtimeId);
    const rowKind = deriveRowKindFacet(record.derivedFacets.rowKind, childRuntime);
    if (childRuntime === undefined && rowKind === record.derivedFacets.rowKind) {
      return record;
    }

    return {
      ...record,
      derivedFacets: {
        ...record.derivedFacets,
        rowKind,
        ...(childRuntime === undefined ? {} : { childRuntime }),
      },
    } as T;
  });
}

export function deriveChildRuntimeFacets(
  records: readonly SessionDeckRecord[],
): Map<string, ChildRuntimeFacet> {
  const indexes = buildIndexes(records);
  const facets = new Map<string, ChildRuntimeFacet>();

  for (const record of records) {
    const facet = deriveChildRuntimeFacet(record, records, indexes);
    if (facet !== undefined) {
      facets.set(record.runtimeId, facet);
    }
  }

  return facets;
}

function deriveRowKindFacet(
  rowKind: SessionRowKindFacet,
  childRuntime: ChildRuntimeFacet | undefined,
): SessionRowKindFacet {
  if (rowKind !== 'ephemeral_runtime') {
    return rowKind;
  }

  return hasRowKindPromotionEvidence(childRuntime) ? 'ephemeral_child_runtime' : rowKind;
}

function hasRowKindPromotionEvidence(childRuntime: ChildRuntimeFacet | undefined): boolean {
  return childRuntime?.candidate === true && childRuntime.evidence.some(isRowKindPromotionEvidence);
}

function isRowKindPromotionEvidence(evidence: ChildRuntimeEvidence): boolean {
  return (
    evidence.code === 'explicit_header_parent' ||
    (evidence.code === 'process_ancestor_match' && evidence.confidence === 'high')
  );
}

function deriveChildRuntimeFacet(
  record: SessionDeckRecord,
  records: readonly SessionDeckRecord[],
  indexes: ParentageIndexes,
): ChildRuntimeFacet | undefined {
  if (hasUntrustedIdentityForParentage(record)) {
    const evidence = [
      ...deriveInheritedDeckRuntimeEvidence(record, indexes),
      ...deriveProcessAncestorEvidence(record, indexes),
    ];
    if (evidence.length === 0) {
      return undefined;
    }

    const parent = resolveDominantParent(evidence);
    return createFacet({
      candidate: false,
      confidence: 'unknown',
      evidence,
      parent,
    });
  }

  const candidate = isInMemorySessionCandidate(record);
  if (!candidate) {
    return undefined;
  }

  const evidence = upgradeToolTimingEvidence([
    ...deriveExplicitHeaderParentEvidence(record, indexes),
    ...deriveInheritedDeckRuntimeEvidence(record, indexes),
    ...deriveProcessAncestorEvidence(record, indexes),
    ...deriveStartedDuringParentToolEvidence(record, records),
    ...deriveSameTerminalEvidence(record, records),
    ...deriveHeadlessInMemoryEvidence(record),
    ...deriveAutomationInputEvidence(record.inputSummary),
  ]);
  const parent = resolveDominantParent(evidence);
  const confidence = deriveOverallConfidence(evidence, parent, candidate);

  return createFacet({ candidate, confidence, evidence, parent });
}

function createFacet({
  candidate,
  confidence,
  evidence,
  parent,
}: {
  candidate: boolean;
  confidence: ChildRuntimeConfidence;
  evidence: ChildRuntimeEvidence[];
  parent: ParentResolution;
}): ChildRuntimeFacet {
  return {
    candidate,
    confidence,
    evidence: evidence.map(sanitizeEvidence),
    ...(parent.parentRuntimeId === undefined ? {} : { parentRuntimeId: parent.parentRuntimeId }),
    ...(parent.parentSessionId === undefined ? {} : { parentSessionId: parent.parentSessionId }),
  };
}

function buildIndexes(records: readonly SessionDeckRecord[]): ParentageIndexes {
  const byRuntimeId = new Map<string, SessionDeckRecord>();
  const bySessionId = new Map<string, SessionDeckRecord[]>();
  const bySessionFile = new Map<string, SessionDeckRecord[]>();
  const byHeaderId = new Map<string, SessionDeckRecord[]>();
  const byProcessPid = new Map<number, SessionDeckRecord[]>();

  for (const record of records) {
    byRuntimeId.set(record.runtimeId, record);
    pushIndex(bySessionId, record.sessionId, record);
    pushIndex(bySessionFile, record.sessionFile, record);
    pushIndex(byHeaderId, record.sessionHeader?.id, record);
    const processPid = record.runtimeSignals?.process?.pid ?? record.pid;
    if (typeof processPid === 'number' && Number.isInteger(processPid) && processPid > 0) {
      pushIndex(byProcessPid, processPid, record);
    }
  }

  return { byRuntimeId, bySessionId, bySessionFile, byHeaderId, byProcessPid };
}

function pushIndex<K>(
  map: Map<K, SessionDeckRecord[]>,
  key: K | null | undefined,
  record: SessionDeckRecord,
): void {
  if (key === null || key === undefined) {
    return;
  }

  if (typeof key === 'string' && key.length === 0) {
    return;
  }

  const existing = map.get(key) ?? [];
  existing.push(record);
  map.set(key, existing);
}

function hasUntrustedIdentityForParentage(record: SessionDeckRecord): boolean {
  return record.identityFreshness === 'missing' || record.identityFreshness === 'very_stale';
}

function isInMemorySessionCandidate(record: SessionDeckRecord): boolean {
  return record.sessionFile === null && hasRealSessionIdentity(record);
}

function hasRealSessionIdentity(record: SessionDeckRecord): boolean {
  return record.sessionId !== null || isNonEmptyString(record.sessionHeader?.id);
}

function deriveExplicitHeaderParentEvidence(
  record: SessionDeckRecord,
  indexes: ParentageIndexes,
): ChildRuntimeEvidence[] {
  const parentSession = record.sessionHeader?.parentSession;
  if (!isNonEmptyString(parentSession)) {
    return [];
  }

  const parents = distinctRecords([
    ...(indexes.bySessionFile.get(parentSession) ?? []),
    ...(indexes.bySessionId.get(parentSession) ?? []),
    ...(indexes.byHeaderId.get(parentSession) ?? []),
  ]).filter((parent) => parent.runtimeId !== record.runtimeId);

  if (parents.length === 0) {
    return [createEvidence('explicit_header_parent', 'explicit')];
  }

  return parents.map((parent) => createEvidence('explicit_header_parent', 'explicit', parent));
}

function deriveInheritedDeckRuntimeEvidence(
  record: SessionDeckRecord,
  indexes: ParentageIndexes,
): ChildRuntimeEvidence[] {
  const inherited = record.runtimeSignals?.inheritedDeckRuntime;
  if (inherited === undefined) {
    return [];
  }

  const parents = distinctRecords([
    ...(isNonEmptyString(inherited.runtimeId)
      ? [indexes.byRuntimeId.get(inherited.runtimeId)].filter(
          (parent): parent is SessionDeckRecord => parent !== undefined,
        )
      : []),
    ...(isNonEmptyString(inherited.sessionId)
      ? (indexes.bySessionId.get(inherited.sessionId) ?? [])
      : []),
    ...(isNonEmptyString(inherited.sessionFile)
      ? (indexes.bySessionFile.get(inherited.sessionFile) ?? [])
      : []),
  ]).filter((parent) => parent.runtimeId !== record.runtimeId);

  if (parents.length === 0) {
    return [createEvidence('inherited_deck_runtime', 'low')];
  }

  return parents.map((parent) => createEvidence('inherited_deck_runtime', 'high', parent));
}

function deriveProcessAncestorEvidence(
  record: SessionDeckRecord,
  indexes: ParentageIndexes,
): ChildRuntimeEvidence[] {
  const ancestors = record.runtimeSignals?.process?.ancestors ?? [];
  const evidence: ChildRuntimeEvidence[] = [];

  for (const ancestor of ancestors) {
    const parents = (indexes.byProcessPid.get(ancestor.pid) ?? []).filter(
      (parent) => parent.runtimeId !== record.runtimeId,
    );
    for (const parent of parents) {
      evidence.push(
        createEvidence(
          'process_ancestor_match',
          doesAncestorStartMatchParent(ancestor, parent) ? 'high' : 'medium',
          parent,
        ),
      );
    }
  }

  return dedupeEvidence(evidence);
}

function deriveStartedDuringParentToolEvidence(
  record: SessionDeckRecord,
  records: readonly SessionDeckRecord[],
): ChildRuntimeEvidence[] {
  const childStartTimes = getRuntimeStartTimeCandidates(record);
  if (childStartTimes.length === 0) {
    return [];
  }

  const evidence: ChildRuntimeEvidence[] = [];
  for (const parent of records) {
    if (parent.runtimeId === record.runtimeId || parent.recentToolWindows === undefined) {
      continue;
    }

    if (
      parent.recentToolWindows.some((window) => childStartsDuringWindow(childStartTimes, window))
    ) {
      evidence.push(createEvidence('started_during_parent_tool', 'low', parent));
    }
  }

  return dedupeEvidence(evidence);
}

function deriveSameTerminalEvidence(
  record: SessionDeckRecord,
  records: readonly SessionDeckRecord[],
): ChildRuntimeEvidence[] {
  const terminalKey = getTerminalClusterKey(record.terminal);
  if (terminalKey === null) {
    return [];
  }

  const evidence: ChildRuntimeEvidence[] = [];
  for (const parent of records) {
    if (parent.runtimeId === record.runtimeId) {
      continue;
    }

    if (getTerminalClusterKey(parent.terminal) === terminalKey) {
      evidence.push(createEvidence('same_terminal', 'low', parent));
    }
  }

  return evidence;
}

function deriveHeadlessInMemoryEvidence(record: SessionDeckRecord): ChildRuntimeEvidence[] {
  if (record.derivedFacets?.persistence !== 'in_memory' || !isHeadlessRuntime(record)) {
    return [];
  }

  return [createEvidence('headless_in_memory', 'low')];
}

function deriveAutomationInputEvidence(
  inputSummary: ActivityInputSummary | undefined,
): ChildRuntimeEvidence[] {
  if (inputSummary === undefined) {
    return [];
  }

  const sawAutomation =
    inputSummary.lastSource === 'rpc' ||
    inputSummary.lastSource === 'extension' ||
    (inputSummary.counts?.rpc ?? 0) > 0 ||
    (inputSummary.counts?.extension ?? 0) > 0;

  return sawAutomation ? [createEvidence('automation_input_source', 'low')] : [];
}

function upgradeToolTimingEvidence(evidence: ChildRuntimeEvidence[]): ChildRuntimeEvidence[] {
  const hasSupport = evidence.some(
    (entry) =>
      entry.code !== 'started_during_parent_tool' && TOOL_TIMING_SUPPORT_CODES.has(entry.code),
  );

  if (!hasSupport) {
    return evidence;
  }

  return evidence.map((entry) =>
    entry.code === 'started_during_parent_tool' && entry.confidence === 'low'
      ? { ...entry, confidence: 'medium' }
      : entry,
  );
}

function deriveOverallConfidence(
  evidence: ChildRuntimeEvidence[],
  parent: ParentResolution,
  candidate: boolean,
): ChildRuntimeConfidence {
  const strongest = evidence.reduce<ChildRuntimeConfidence>(
    (current, entry) =>
      CONFIDENCE_WEIGHT[entry.confidence] > CONFIDENCE_WEIGHT[current] ? entry.confidence : current,
    candidate ? 'none' : 'unknown',
  );

  if (parent.conflicted && CONFIDENCE_WEIGHT[strongest] > CONFIDENCE_WEIGHT.medium) {
    return 'medium';
  }

  return strongest;
}

function resolveDominantParent(evidence: readonly ChildRuntimeEvidence[]): ParentResolution {
  const scores = new Map<
    string,
    { parentRuntimeId: string; parentSessionId?: string; maxWeight: number; count: number }
  >();

  for (const entry of evidence) {
    if (entry.parentRuntimeId === undefined) {
      continue;
    }

    const existing = scores.get(entry.parentRuntimeId) ?? {
      parentRuntimeId: entry.parentRuntimeId,
      ...(entry.parentSessionId === undefined ? {} : { parentSessionId: entry.parentSessionId }),
      maxWeight: 0,
      count: 0,
    };
    existing.maxWeight = Math.max(existing.maxWeight, CONFIDENCE_WEIGHT[entry.confidence]);
    existing.count += 1;
    if (existing.parentSessionId === undefined && entry.parentSessionId !== undefined) {
      existing.parentSessionId = entry.parentSessionId;
    }
    scores.set(entry.parentRuntimeId, existing);
  }

  const ordered = [...scores.values()].sort(
    (left, right) => right.maxWeight - left.maxWeight || right.count - left.count,
  );
  const top = ordered[0];
  if (top === undefined || top.maxWeight < CONFIDENCE_WEIGHT.medium) {
    return { conflicted: false };
  }

  const second = ordered[1];
  const dominant =
    second === undefined ||
    top.maxWeight > second.maxWeight ||
    (top.maxWeight >= CONFIDENCE_WEIGHT.high && top.count > second.count);

  if (!dominant) {
    return { conflicted: true };
  }

  return {
    parentRuntimeId: top.parentRuntimeId,
    ...(top.parentSessionId === undefined ? {} : { parentSessionId: top.parentSessionId }),
    conflicted: false,
  };
}

function createEvidence(
  code: ChildRuntimeEvidenceCode,
  confidence: ChildRuntimeConfidence,
  parent?: SessionDeckRecord,
): ChildRuntimeEvidence {
  return {
    code,
    confidence,
    ...(parent === undefined ? {} : { parentRuntimeId: parent.runtimeId }),
    ...(parent?.sessionId === undefined || parent.sessionId === null
      ? {}
      : { parentSessionId: parent.sessionId }),
  };
}

function sanitizeEvidence(evidence: ChildRuntimeEvidence): ChildRuntimeEvidence {
  return {
    code: evidence.code,
    confidence: evidence.confidence,
    ...(evidence.parentRuntimeId === undefined
      ? {}
      : { parentRuntimeId: evidence.parentRuntimeId }),
    ...(evidence.parentSessionId === undefined
      ? {}
      : { parentSessionId: evidence.parentSessionId }),
  };
}

function dedupeEvidence(evidence: ChildRuntimeEvidence[]): ChildRuntimeEvidence[] {
  const seen = new Set<string>();
  const deduped: ChildRuntimeEvidence[] = [];
  for (const entry of evidence) {
    const key = [
      entry.code,
      entry.confidence,
      entry.parentRuntimeId ?? '',
      entry.parentSessionId ?? '',
    ].join('\0');
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(entry);
  }
  return deduped;
}

function distinctRecords(records: SessionDeckRecord[]): SessionDeckRecord[] {
  const seen = new Set<string>();
  const distinct: SessionDeckRecord[] = [];
  for (const record of records) {
    if (seen.has(record.runtimeId)) {
      continue;
    }
    seen.add(record.runtimeId);
    distinct.push(record);
  }
  return distinct;
}

function doesAncestorStartMatchParent(
  ancestor: SessionRuntimeProcessAncestorMetadata,
  parent: SessionDeckRecord,
): boolean {
  const parentProcessStartedAt =
    parent.runtimeSignals?.process?.processStartedAt ?? parent.startedAt;
  return timestampsMatch(ancestor.processStartedAt, parentProcessStartedAt);
}

function getRuntimeStartTimeCandidates(record: SessionDeckRecord): number[] {
  const rawCandidates = [record.runtimeSignals?.process?.processStartedAt, record.startedAt];
  const times = rawCandidates
    .map((value) => (typeof value === 'string' ? Date.parse(value) : Number.NaN))
    .filter((value) => Number.isFinite(value));
  return [...new Set(times)];
}

function childStartsDuringWindow(
  childStartTimes: readonly number[],
  window: ActivityToolWindow,
): boolean {
  const startedAtMs = Date.parse(window.startedAt);
  if (!Number.isFinite(startedAtMs)) {
    return false;
  }

  const endedAtMs =
    window.endedAt === undefined ? Number.POSITIVE_INFINITY : Date.parse(window.endedAt);
  if (!Number.isFinite(endedAtMs) && window.endedAt !== undefined) {
    return false;
  }

  return childStartTimes.some(
    (childStartMs) => childStartMs >= startedAtMs && childStartMs <= endedAtMs,
  );
}

function getTerminalClusterKey(terminal: SessionTerminalMetadata | undefined): string | null {
  if (terminal === undefined) {
    return null;
  }

  if (terminal.kind === 'iterm2') {
    return `iterm2:${terminal.sessionId}`;
  }

  if (terminal.kind === 'ghostty') {
    return `ghostty:${terminal.terminalId}`;
  }

  const socket = terminal.socketPath ?? terminal.socketName ?? '';
  const location = terminal.paneId ?? terminal.windowId ?? terminal.sessionId ?? '';
  if (socket.length === 0 || location.length === 0) {
    return null;
  }

  return `tmux:${socket}:${terminal.sessionName}:${location}`;
}

function isHeadlessRuntime(record: SessionDeckRecord): boolean {
  if (record.derivedFacets?.interactivity === 'headless') {
    return true;
  }

  const mode = record.runtimeSignals?.launch?.mode;
  return mode === 'json' || mode === 'print' || record.sessionStart?.hasUI === false;
}

function timestampsMatch(left: string | undefined, right: string | undefined): boolean {
  if (!isNonEmptyString(left) || !isNonEmptyString(right)) {
    return false;
  }

  if (left === right) {
    return true;
  }

  const leftMs = Date.parse(left);
  const rightMs = Date.parse(right);
  return Number.isFinite(leftMs) && Number.isFinite(rightMs) && Math.abs(leftMs - rightMs) <= 1_000;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

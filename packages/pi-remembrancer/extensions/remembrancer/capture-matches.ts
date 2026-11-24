import { isDeepStrictEqual } from 'node:util';
import type { Proposal, TaskChange, TaskSnapshot } from './proposals.js';
import type { FindingRecord, FoldedFinding } from './review-findings.js';
import { satisfies, snapshot, type TaskRecord } from './taskwarrior.js';

export type CaptureMatches = ReturnType<typeof resolveCaptureMatches>;
export type ResolvedCapture = {
  record: FindingRecord;
  state: FoldedFinding;
  matches: CaptureMatches;
};

/** Candidate membership is not identity. Never choose the first of several matches. */
export function resolveCaptureMatches(
  tasks: readonly TaskRecord[],
  proposals: readonly Proposal[],
  ambiguous = false,
  intentTarget?: string,
) {
  const exactTasks = [...new Map(tasks.map((task) => [task['uuid'], task])).values()];
  const exactProposals = [
    ...new Map(proposals.map((proposal) => [proposal.id, proposal])).values(),
  ];
  const pending = exactProposals.filter((proposal) => proposal.state === 'pending');
  const identities = new Set(exactTasks.map((task) => `task:${task['uuid']}`));
  for (const proposal of exactProposals) {
    const change = (proposal.draft ?? proposal).change;
    const uuid =
      change.operation !== 'add'
        ? change.targetUuid
        : (proposal.result?.verified?.uuid ?? proposal.claim);
    identities.add(uuid ? `task:${uuid}` : `proposal:${proposal.id}`);
  }
  ambiguous ||=
    identities.size > 1 ||
    pending.length > 1 ||
    (!!intentTarget && identities.size > 0 && !identities.has(`task:${intentTarget}`));
  const key = !ambiguous && identities.size === 1 ? [...identities][0]! : null;
  const proposal = key ? pending[0] : undefined;
  const task = key ? exactTasks[0] : undefined;
  const expected: TaskSnapshot | null = key
    ? task
      ? snapshot(task)
      : ((proposal?.draft ?? proposal)?.expected ??
        exactProposals.find((item) => item.result?.verified)?.result?.verified ??
        (exactProposals[0]?.draft ?? exactProposals[0])?.expected ??
        null)
    : null;
  return {
    key,
    ambiguous,
    tasks: exactTasks,
    proposals: exactProposals,
    proposal,
    expected,
    verifyOnly: exactProposals.some((item) => ['applying', 'uncertain'].includes(item.state)),
    questions: exactProposals.map((item) => (item.draft ?? item).question),
  };
}

/** Only observable satisfaction can dispose active intent without a proposal. */
export function captureIsSatisfied(state: FoldedFinding, matches: CaptureMatches): boolean {
  if (matches.ambiguous || matches.proposal) return false;
  const task = matches.tasks[0];
  // An interrupted application is not permission for another write. A live task
  // must prove both the saved operation and the current intent already satisfied.
  if (
    matches.verifyOnly &&
    (!task ||
      matches.proposals.some(
        (proposal) =>
          ['applying', 'uncertain'].includes(proposal.state) &&
          !satisfies(
            (proposal.draft ?? proposal).change,
            task,
            proposal.applicationBefore?.status ??
              (proposal.draft ?? proposal).expected?.status ??
              'pending',
          ),
      ))
  )
    return false;
  const satisfied = (actual: TaskRecord): boolean =>
    state.status === 'completed'
      ? satisfies(
          {
            operation: 'complete',
            targetUuid: String(actual['uuid']),
            annotations: state.draft?.change.annotations ?? [],
          },
          actual,
        )
      : state.status === 'active' &&
        actual['status'] !== 'deleted' &&
        !!state.draft &&
        satisfies(state.draft.change, actual, actual['status']);
  if (task) return satisfied(task);
  const verified = matches.proposals.find((proposal) =>
    ['applied', 'already_satisfied'].includes(proposal.state),
  )?.result?.verified;
  return (
    !!verified &&
    satisfied({
      ...verified.fields,
      uuid: verified.uuid,
      status: verified.status,
      annotations: verified.annotations,
    })
  );
}

/** Independent records are not an ancestry-ordered correction chain. */
export function captureChangesConflict(states: readonly FoldedFinding[]): boolean {
  if (new Set(states.map((state) => state.status)).size > 1) return true;
  const fields = new Map<string, unknown>();
  for (const state of states) {
    const change = state.draft?.change;
    if (!change || change.operation === 'complete') continue;
    for (const [key, value] of Object.entries(change.fields)) {
      if (fields.has(key) && !isDeepStrictEqual(fields.get(key), value)) return true;
      fields.set(key, value);
    }
  }
  return false;
}

/** A consolidated question-free edit must retain each compatible requested change. */
export function validateConsolidatedChange(change: TaskChange, states: readonly FoldedFinding[]) {
  for (const state of states) {
    const intent = state.draft?.change;
    if (!intent) continue;
    if (intent.annotations.some((annotation) => !change.annotations.includes(annotation)))
      throw new Error('Consolidation dropped requested annotations');
    if (intent.operation !== 'complete') {
      if (
        change.operation === 'complete' ||
        Object.entries(intent.fields).some(
          ([key, value]) =>
            !isDeepStrictEqual(change.fields[key as keyof typeof change.fields], value),
        )
      )
        throw new Error('Consolidation dropped requested fields');
    }
  }
}

/** Group only definite identity, leaving unrelated and uncertain records separate. */
export function groupCaptureMatches(resolved: readonly ResolvedCapture[]): ResolvedCapture[][] {
  const groups = new Map<string, ResolvedCapture[]>();
  for (const item of resolved) {
    const key = item.matches.key ?? `record:${item.record.id}`;
    const group = groups.get(key) ?? [];
    group.push(item);
    groups.set(key, group);
  }
  return [...groups.values()];
}

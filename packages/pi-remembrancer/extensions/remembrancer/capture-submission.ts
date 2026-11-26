import { Type, type Static } from '@sinclair/typebox';
import { isDeepStrictEqual } from 'node:util';
import type { CaptureReview } from './capture-review.js';
import {
  proposalParameters,
  type EvidenceReference,
  type Proposal,
  type ProposalSubmission,
} from './proposals.js';
import {
  captureChangesConflict,
  captureIsSatisfied,
  groupCaptureMatches,
  resolveCaptureMatches,
  validateConsolidatedChange,
  type ResolvedCapture,
} from './capture-matches.js';
import { findingKinds, folded, object, text, validateMaterialization } from './review-findings.js';
import type { TaskRecord } from './taskwarrior.js';

const intent = Type.Pick(proposalParameters, ['change', 'question']);
const state = Type.Object(
  {
    summary: Type.String({ minLength: 1 }),
    status: Type.String({ enum: ['active', 'completed', 'refused', 'uncertain'] }),
    draft: Type.Union([Type.Null(), intent]),
  },
  { additionalProperties: false },
);
const candidate = Type.Object(
  {
    kind: Type.String({ enum: ['task', 'proposal'] }),
    id: Type.String({ minLength: 1 }),
    revision: Type.Optional(Type.Integer({ minimum: 1 })),
    judgment: Type.String({ enum: ['same', 'different', 'ambiguous'] }),
  },
  { additionalProperties: false },
);
export const captureSubmitParameters = Type.Object(
  {
    records: Type.Array(
      Type.Object(
        {
          key: Type.String({ minLength: 1 }),
          observations: Type.Array(
            Type.Object(
              {
                kind: Type.String({ enum: findingKinds }),
                reference: proposalParameters.properties.references.items,
              },
              { additionalProperties: false },
            ),
            { minItems: 1 },
          ),
          states: Type.Array(
            Type.Object({ branchId: Type.String(), state }, { additionalProperties: false }),
            { minItems: 1 },
          ),
          ambiguous: Type.Boolean(),
          candidates: Type.Array(candidate),
        },
        { additionalProperties: false },
      ),
    ),
    dispositions: Type.Array(
      Type.Object(
        {
          records: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, uniqueItems: true }),
          reason: Type.String({ minLength: 1 }),
          submission: Type.Union([
            Type.Null(),
            Type.Pick(proposalParameters, ['change', 'question', 'explanation']),
          ]),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);
export type CaptureSubmission = Static<typeof captureSubmitParameters>;

function fields(value: unknown, allowed: string[]): Record<string, unknown> {
  const data = object(value);
  if (Object.keys(data).some((key) => !allowed.includes(key)))
    throw new Error('Unknown finalized capture fields');
  return data;
}
function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error('Invalid finalized capture array');
  return value;
}

/** Validate declarations, never discover, regroup, or finish proposal content for the reviewer. */
export function validateCaptureSubmission(
  value: unknown,
  current: CaptureReview,
  tasks: readonly TaskRecord[],
  saved: readonly Proposal[],
): ProposalSubmission[] {
  const payload = fields(value, ['records', 'dispositions']);
  const records = new Map<
    string,
    {
      resolved: ResolvedCapture;
      states: ReturnType<typeof folded>[];
      references: EvidenceReference[];
    }
  >();
  for (const raw of array(payload['records'])) {
    const data = fields(raw, ['key', 'observations', 'states', 'ambiguous', 'candidates']);
    const key = text(data['key']);
    if (records.has(key) || typeof data['ambiguous'] !== 'boolean')
      throw new Error('Duplicate capture record or invalid ambiguity');
    const observations = array(data['observations']).map((raw) => {
      const observation = fields(raw, ['kind', 'reference']);
      if (!findingKinds.includes(observation['kind'] as (typeof findingKinds)[number]))
        throw new Error('Invalid capture observation kind');
      return observation;
    });
    const references = observations.map((item) => item['reference'] as EvidenceReference);
    // All records, even null dispositions, require exact eligible sources. Context is excluded.
    current.validateReferences(references);
    const branches = new Set(references.map((ref) => ref.branchId));
    const states = array(data['states']).map((raw) => {
      const branch = fields(raw, ['branchId', 'state']);
      if (!branches.delete(text(branch['branchId'])))
        throw new Error('State must identify exactly one observed branch');
      const supplied = fields(branch['state'], ['summary', 'status', 'draft']);
      if (supplied['draft'] !== null) fields(supplied['draft'], ['change', 'question']);
      return folded(supplied);
    });
    if (branches.size || !states.length) throw new Error('Missing branch-specific capture state');
    const matchedTasks: TaskRecord[] = [];
    const matchedProposals: Proposal[] = [];
    let ambiguous = data['ambiguous'];
    const seenCandidates = new Set<string>();
    for (const raw of array(data['candidates'])) {
      const candidate = fields(raw, ['kind', 'id', 'revision', 'judgment']);
      const id = text(candidate['id']);
      const identity = `${candidate['kind']}:${id}`;
      if (seenCandidates.has(identity)) throw new Error('Repeated capture candidate');
      seenCandidates.add(identity);
      if (!['same', 'different', 'ambiguous'].includes(candidate['judgment'] as string))
        throw new Error('Invalid capture candidate judgment');
      let task: TaskRecord | undefined;
      let proposal: Proposal | undefined;
      if (candidate['kind'] === 'task' && candidate['revision'] === undefined) {
        task = tasks.find((item) => item['uuid'] === id);
        if (!task) throw new Error('Unknown retained task candidate');
      } else if (candidate['kind'] === 'proposal') {
        proposal = saved.find((item) => item.id === id);
        if (!proposal || proposal.revision !== candidate['revision'])
          throw new Error('Missing or stale retained proposal candidate');
      } else throw new Error('Invalid capture candidate identity');
      ambiguous ||= candidate['judgment'] === 'ambiguous';
      if (candidate['judgment'] !== 'same') continue;
      if (task) matchedTasks.push(task);
      if (proposal) {
        matchedProposals.push(proposal);
        const uuid = proposal.result?.verified?.uuid;
        if (uuid && ['applied', 'already_satisfied'].includes(proposal.state)) {
          const live = tasks.find((item) => item['uuid'] === uuid);
          if (!live) throw new Error('Matched saved result has no live task; capture unresolved');
          matchedTasks.push(live);
        }
      }
    }
    if (
      !observations.some((item) => item['kind'] === 'accepted') &&
      !matchedTasks.length &&
      !matchedProposals.length &&
      !states.every(
        (state) =>
          (state.status === 'completed' &&
            observations.some((item) => item['kind'] === 'completion')) ||
          (state.status === 'refused' && observations.some((item) => item['kind'] === 'refusal')),
      )
    )
      ambiguous = true;
    const targets = new Set(
      states.flatMap((state) => {
        const change = state.draft?.change;
        return change && change.operation !== 'add' ? [change.targetUuid] : [];
      }),
    );
    ambiguous ||= targets.size > 1;
    const matches = resolveCaptureMatches(
      matchedTasks,
      matchedProposals,
      ambiguous,
      [...targets][0],
    );
    records.set(key, {
      resolved: {
        record: { id: key, ambiguous: matches.ambiguous },
        state: states[0]!,
        matches,
      },
      states,
      references,
    });
  }
  const requiredGroups = groupCaptureMatches(
    [...records.values()].map((item) => item.resolved),
  ).map((group) => new Set(group.map((item) => item.record.id)));
  const disposed = new Set<string>();
  const submissions: ProposalSubmission[] = [];
  for (const raw of array(payload['dispositions'])) {
    const disposition = fields(raw, ['records', 'reason', 'submission']);
    text(disposition['reason']);
    const keys = array(disposition['records']).map(text);
    const keySet = new Set(keys);
    if (
      !keys.length ||
      keySet.size !== keys.length ||
      keys.some((key) => !records.has(key) || disposed.has(key))
    )
      throw new Error('Every record requires exactly one disposition');
    if (
      !requiredGroups.some(
        (group) => group.size === keySet.size && [...group].every((key) => keySet.has(key)),
      )
    )
      throw new Error('Declared disposition does not match definite identities');
    keys.forEach((key) => disposed.add(key));
    const group = keys.map((key) => records.get(key)!);
    const states = group.flatMap((item) => item.states);
    const matches = resolveCaptureMatches(
      group.flatMap((item) => item.resolved.matches.tasks),
      group.flatMap((item) => item.resolved.matches.proposals),
      group.some((item) => item.resolved.matches.ambiguous),
    );
    const conflictingChanges = captureChangesConflict(states);
    const satisfied = states.every((state) => captureIsSatisfied(state, matches));
    if (matches.verifyOnly && (!satisfied || disposition['submission'] !== null))
      throw new Error('Matched saved application is verify-only; capture unresolved');
    if (disposition['submission'] !== null)
      fields(disposition['submission'], ['change', 'question', 'explanation']);
    let materialized: ReturnType<typeof validateMaterialization> = null;
    for (const state of states) {
      const validated = validateMaterialization(
        disposition,
        { id: keys[0]!, ambiguous: matches.ambiguous },
        state,
        {
          expected: matches.expected,
          conflictingChanges,
          allowNoop: satisfied,
          tracked: matches.tasks.length > 0 || matches.proposals.length > 0,
          questions: [...matches.questions, ...states.map((item) => item.draft?.question)],
        },
      );
      if (materialized && !isDeepStrictEqual(materialized, validated))
        throw new Error('Inconsistent finalized capture materialization');
      materialized = validated;
    }
    const pending = matches.proposal;
    if (!materialized && pending)
      throw new Error('Saved pending proposal requires a revision or question');
    if (
      !materialized &&
      matches.proposals.some((item) => item.state === 'dismissed') &&
      states.some((state) => state.status === 'active')
    )
      throw new Error('Dismissed proposal is not verified satisfaction');
    if (!materialized) continue;
    if (!materialized.question && group.length > 1)
      validateConsolidatedChange(materialized.change, states);
    if (
      pending &&
      (pending.draft ?? pending).change.operation !== 'add' &&
      materialized.change.operation === 'add'
    )
      throw new Error('Saved existing-task proposal cannot become an addition');
    if (matches.proposals.some((item) => item.state === 'dismissed') && !materialized.question)
      throw new Error('Reopening a dismissed obligation requires a question');
    submissions.push({
      ...materialized,
      references: group.flatMap((item) => item.references),
      ...(pending ? { id: pending.id, expectedRevision: pending.revision } : {}),
    });
  }
  if (disposed.size !== records.size)
    throw new Error('Every record requires exactly one disposition');
  // Recheck permissions, exact citations and trusted snapshots using the publication validator.
  current.completion(submissions);
  return structuredClone(submissions);
}

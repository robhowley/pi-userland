import { resolve } from 'node:path';
import { Type } from '@sinclair/typebox';
import type { Evidence } from './evidence.js';

export type TaskFields = {
  description?: string;
  project?: string | null;
  due?: string | null;
  wait?: string | null;
  scheduled?: string | null;
  priority?: 'H' | 'M' | 'L' | null;
  waitingon?: string | null;
  tags?: string[];
  depends?: string[];
};
export type TaskSnapshot = {
  uuid: string;
  status: 'pending' | 'completed' | 'deleted' | 'waiting' | 'recurring';
  fields: TaskFields & { description: string };
  annotations: { entry: string; description: string }[];
};
export type TaskChange =
  | { operation: 'add'; fields: TaskFields & { description: string }; annotations: string[] }
  | { operation: 'update'; targetUuid: string; fields: TaskFields; annotations: string[] }
  | { operation: 'complete'; targetUuid: string; annotations: string[] };
export type ProposalDraft = {
  change: TaskChange;
  expected: TaskSnapshot | null;
  question: string | null;
};
export type EvidenceReference = Pick<Evidence, 'sessionId' | 'branchId' | 'entryId' | 'editId'> & {
  offset: number;
  quote: string;
};
export type ProposalSource = EvidenceReference &
  Pick<Evidence, 'file' | 'role' | 'timestamp'> & { locator: string };
export type ProposalSubmission = ProposalDraft & {
  id?: string;
  expectedRevision?: number;
  explanation: string;
  references: EvidenceReference[];
};
export type ProposalState =
  | 'pending'
  | 'dismissed'
  | 'applying'
  | 'applied'
  | 'already_satisfied'
  | 'failed'
  | 'uncertain';
export type ApplicationResult = { actual?: Record<string, unknown> | null } & (
  | { state: 'applied' | 'already_satisfied'; verified: TaskSnapshot; error: null }
  | { state: 'failed' | 'uncertain'; verified: TaskSnapshot | null; error: string }
);
export type Proposal = ProposalDraft & {
  id: string;
  revision: number;
  draft: ProposalDraft | null;
  explanation: string;
  sources: ProposalSource[];
  state: ProposalState;
  claim: string | null;
  applicationBefore?: TaskSnapshot | null;
  result: ApplicationResult | null;
  createdAt: string;
  updatedAt: string;
  history?: Omit<Proposal, 'history'>[];
};

export function stringEnumSchema<const Values extends readonly string[]>(values: Values) {
  return Type.Unsafe<Values[number]>({
    type: 'string',
    enum: values as unknown as Values[number][],
  });
}

const nullableText = Type.Union([Type.String(), Type.Null()]);
const taskFieldProperties = {
  description: Type.Optional(Type.String()),
  project: Type.Optional(nullableText),
  due: Type.Optional(nullableText),
  wait: Type.Optional(nullableText),
  scheduled: Type.Optional(nullableText),
  priority: Type.Optional(Type.Union([stringEnumSchema(['H', 'M', 'L']), Type.Null()])),
  waitingon: Type.Optional(nullableText),
  tags: Type.Optional(Type.Array(Type.String())),
  depends: Type.Optional(Type.Array(Type.String())),
};
const fieldsSchema = Type.Object(taskFieldProperties, { additionalProperties: false });
const addFieldsSchema = Type.Object(
  { ...taskFieldProperties, description: Type.String() },
  { additionalProperties: false },
);
const annotationsSchema = Type.Array(Type.String());
export const proposalParameters = Type.Object(
  {
    id: Type.Optional(Type.String()),
    expectedRevision: Type.Optional(Type.Integer({ minimum: 1 })),
    change: Type.Union([
      Type.Object(
        { operation: Type.Literal('add'), fields: addFieldsSchema, annotations: annotationsSchema },
        { additionalProperties: false },
      ),
      Type.Object(
        {
          operation: Type.Literal('update'),
          targetUuid: Type.String(),
          fields: fieldsSchema,
          annotations: annotationsSchema,
        },
        { additionalProperties: false },
      ),
      Type.Object(
        {
          operation: Type.Literal('complete'),
          targetUuid: Type.String(),
          annotations: annotationsSchema,
        },
        { additionalProperties: false },
      ),
    ]),
    expected: Type.Union([
      Type.Null(),
      Type.Object(
        {
          uuid: Type.String(),
          status: stringEnumSchema(['pending', 'completed', 'deleted', 'waiting', 'recurring']),
          fields: addFieldsSchema,
          annotations: Type.Array(
            Type.Object(
              { entry: Type.String(), description: Type.String() },
              { additionalProperties: false },
            ),
          ),
        },
        { additionalProperties: false },
      ),
    ]),
    question: nullableText,
    explanation: Type.String(),
    references: Type.Array(
      Type.Object(
        {
          sessionId: Type.String(),
          branchId: Type.String(),
          entryId: Type.String(),
          editId: nullableText,
          offset: Type.Integer({ minimum: 0 }),
          quote: Type.String(),
        },
        { additionalProperties: false },
      ),
      { minItems: 1 },
    ),
  },
  { additionalProperties: false },
);

function object(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !keys.includes(key))
  )
    throw new Error('Invalid proposal fields');
}
function text(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Expected nonempty text');
}
function uuid(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/iu.test(value))
    throw new Error('Expected full task UUID');
}
function fields(value: unknown) {
  object(value, [
    'description',
    'project',
    'due',
    'wait',
    'scheduled',
    'priority',
    'waitingon',
    'tags',
    'depends',
  ]);
  for (const [key, item] of Object.entries(value)) {
    if (key === 'tags' || key === 'depends') {
      if (!Array.isArray(item)) throw new Error('Expected task field array');
      for (const element of item) {
        if (key === 'depends') uuid(element);
        else text(element);
      }
    } else if (key === 'priority') {
      if (item !== null && !['H', 'M', 'L'].includes(item as string))
        throw new Error('Invalid priority');
    } else if (item !== null || key === 'description') text(item);
  }
}
export function validateSnapshot(value: TaskSnapshot): void {
  object(value, ['uuid', 'status', 'fields', 'annotations']);
  uuid(value.uuid);
  if (!['pending', 'completed', 'deleted', 'waiting', 'recurring'].includes(value.status))
    throw new Error('Invalid task status');
  fields(value.fields);
  text(value.fields.description);
  if (!Array.isArray(value.annotations)) throw new Error('Invalid annotations');
  for (const annotation of value.annotations) {
    object(annotation, ['entry', 'description']);
    text(annotation.entry);
    text(annotation.description);
  }
}
export function validateDraft(value: ProposalDraft): void {
  object(value, ['change', 'expected', 'question']);
  const change = value.change;
  object(
    change,
    change?.operation === 'add'
      ? ['operation', 'fields', 'annotations']
      : change?.operation === 'complete'
        ? ['operation', 'targetUuid', 'annotations']
        : ['operation', 'targetUuid', 'fields', 'annotations'],
  );
  if (!['add', 'update', 'complete'].includes(change.operation))
    throw new Error('Invalid operation');
  if (!Array.isArray(change.annotations)) throw new Error('Invalid annotations');
  change.annotations.forEach(text);
  if (change.operation !== 'complete') fields(change.fields);
  if (change.operation === 'add') {
    text(change.fields.description);
    if (value.expected !== null) throw new Error('Add cannot have an expected task');
  } else {
    uuid(change.targetUuid);
    if (!value.expected) throw new Error('Existing task requires expected snapshot');
    validateSnapshot(value.expected);
    if (value.expected.uuid !== change.targetUuid)
      throw new Error('Task snapshot does not match target');
  }
  if (value.question !== null) text(value.question);
}
export function validateSubmission(
  value: ProposalSubmission,
  evidence: readonly Evidence[],
): ProposalSource[] {
  object(value, [
    'id',
    'expectedRevision',
    'change',
    'expected',
    'question',
    'explanation',
    'references',
  ]);
  validateDraft({ change: value.change, expected: value.expected, question: value.question });
  text(value.explanation);
  if ((value.id === undefined) !== (value.expectedRevision === undefined))
    throw new Error('Revision requires proposal ID');
  if (value.id !== undefined) {
    text(value.id);
    if (!Number.isSafeInteger(value.expectedRevision) || value.expectedRevision! < 1)
      throw new Error('Invalid expected revision');
  }
  if (!Array.isArray(value.references) || !value.references.length)
    throw new Error('Proposal requires eligible evidence');
  return value.references.map((ref) => {
    object(ref, ['sessionId', 'branchId', 'entryId', 'editId', 'offset', 'quote']);
    text(ref.quote);
    const item = evidence.find(
      (item) =>
        item.sessionId === ref.sessionId &&
        item.branchId === ref.branchId &&
        item.entryId === ref.entryId &&
        item.editId === ref.editId,
    );
    if (
      !item ||
      !Number.isSafeInteger(ref.offset) ||
      ref.offset < 0 ||
      item.text.slice(ref.offset, ref.offset + ref.quote.length) !== ref.quote
    )
      throw new Error('Reference does not match frozen eligible evidence');
    return {
      ...ref,
      file: resolve(item.file),
      role: item.role,
      timestamp: item.timestamp,
      locator: `${item.sessionId}/${item.branchId}/${item.entryId}`,
    };
  });
}

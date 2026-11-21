import type { ReviewerStepInput } from '../../extensions/remembrancer/reviewer.js';
import type { FoldedFinding } from '../../extensions/remembrancer/review-findings.js';

export function providerInstruction(
  messages: { role: string; content?: string | { type: string; text?: string }[] }[],
): string {
  const content = messages.filter((message) => message.role === 'user').at(-1)!.content!;
  return typeof content === 'string' ? content : content.map((part) => part.text ?? '').join('');
}

type Observation = {
  label: string;
  kind: string;
  range: {
    text: string;
    offset: number;
    end: number;
    occurrenceCount: number;
    occurrences: { entryId: string }[];
  };
};
type Work = {
  range?: Observation['range'];
  observationOffset?: number;
  maxObservations?: number;
  catalogue?: { handle?: string; id: string; label: string }[];
  observation?: Observation;
  candidate?: { first: Observation };
  previous?: FoldedFinding;
  alternative?: FoldedFinding;
  conflict?: boolean;
  state?: FoldedFinding;
  ambiguous?: boolean;
  savedPending?: object;
};
export function stepWork(instruction: string): Work {
  return JSON.parse(instruction.slice(instruction.lastIndexOf('\n') + 1)).work;
}

/** Deterministic local provider behavior, not a semantic-recognition benchmark. */
export function captureAnswer(instruction: string, empty = false): unknown {
  const work = stepWork(instruction);
  if (work.range) {
    const range = work.range;
    const marker = /^(accepted|correction|completion|refusal|progress|reference):([^|]+)\|/.exec(
      range.text,
    );
    return {
      complete: true,
      observations:
        empty || (!marker && !/^(?:I will|Send Maya)/.test(range.text))
          ? []
          : [
              {
                kind: marker?.[1] ?? 'accepted',
                label: marker?.[2] ?? 'comparison',
                start: range.offset,
                end: range.end,
              },
            ],
    };
  }
  if (work.catalogue)
    return {
      candidates: work.catalogue
        .filter(
          (item) =>
            !item.handle &&
            (item.label === work.observation!.label || work.observation!.label === 'it'),
        )
        .map((item) => item.id),
    };
  if (instruction.includes('All exact candidate fields'))
    return { match: 'different', state: work.state };
  if ('page' in work) return { notes: 'Exact candidate field inspected' };
  if (work.candidate)
    return {
      match:
        work.observation!.label === work.candidate.first.label || work.observation!.label === 'it'
          ? 'same'
          : 'different',
    };
  if (work.observation) {
    const observation = work.observation;
    const exact = observation as Observation & { start: number; end: number };
    const description =
      observation.range.text
        .slice(exact.start - observation.range.offset, exact.end - observation.range.offset)
        .split('|')[1] ?? observation.label;
    return {
      summary:
        observation.label === 'it' ? (work.previous?.summary ?? 'comparison') : observation.label,
      status:
        observation.kind === 'completion'
          ? 'completed'
          : observation.kind === 'refusal'
            ? 'refused'
            : 'active',
      draft: {
        change: { operation: 'add', fields: { description }, annotations: [] },
        expected: null,
        question: null,
      },
    };
  }
  if (work.alternative)
    return {
      state: work.previous,
      conflict:
        work.conflict ||
        JSON.stringify(work.previous!.draft) !== JSON.stringify(work.alternative.draft) ||
        work.previous!.status !== work.alternative.status,
    };
  if (instruction.includes('Materialize')) {
    const state = work.state as FoldedFinding;
    return {
      reason: 'Fixture disposition',
      submission:
        state.status === 'completed' && !work.ambiguous && !work.savedPending
          ? null
          : {
              ...(state.draft ?? {
                change: {
                  operation: 'add',
                  fields: { description: state.summary },
                  annotations: [],
                },
                expected: null,
                question: null,
              }),
              question:
                work.ambiguous ||
                state.status === 'uncertain' ||
                state.status === 'refused' ||
                state.status === 'completed'
                  ? 'Resolve the conflicting interpretation?'
                  : (state.draft?.question ?? null),
              explanation: 'Explicit fixture evidence',
            },
    };
  }
  throw new Error(`Unhandled fixture step: ${instruction.slice(0, 100)}`);
}

export async function answerCapture(
  input: ReviewerStepInput,
  answer = captureAnswer(input.instruction),
) {
  const tool = input.tools[0]!;
  await tool.execute(
    'fixture',
    { result: { answer } },
    undefined,
    undefined,
    {} as Parameters<typeof tool.execute>[4],
  );
  return {
    status: 'handoff' as const,
    message: {} as Awaited<
      ReturnType<typeof import('../../extensions/remembrancer/reviewer.js').runReviewerStep>
    >['message'],
  };
}

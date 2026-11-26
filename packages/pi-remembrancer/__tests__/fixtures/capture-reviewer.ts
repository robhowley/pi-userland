import type { CaptureSubmission } from '../../extensions/remembrancer/capture-submission.js';
import type { EvidenceReference } from '../../extensions/remembrancer/proposals.js';
import type {
  EvidencePageEntry,
  groupEvidencePage,
} from '../../extensions/remembrancer/review-pages.js';
import type { ContinuingReviewerInput } from '../../extensions/remembrancer/reviewer.js';

export type CaptureRecord = CaptureSubmission['records'][number];
export type CaptureDisposition = CaptureSubmission['dispositions'][number];
export type CaptureToolCall = { name: string; args: object };
type EvidencePage = {
  groups: ReturnType<typeof groupEvidencePage>;
  hasMore: boolean;
};

/** Shared by mocked runners and loopback providers. No filesystem reads bypass the tools. */
export function reviewerPaths(instruction: string) {
  const match = /Read `([^`]+)` first, then read `([^`]+)` in order/.exec(instruction);
  if (!match) throw new Error('Missing capture reviewer paths');
  return { skill: match[1]!, review: match[2]! };
}

/** Coordinates are relative to this delivered fragment, returned references are absolute UTF-16. */
export function captureReference(
  entry: EvidencePageEntry,
  start = 0,
  end = entry.text.length,
): EvidenceReference {
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    end <= start ||
    end > entry.text.length
  )
    throw new Error('Invalid fixture quote range');
  return {
    sessionId: entry.sessionId,
    branchId: entry.branchId,
    entryId: entry.entryId,
    editId: entry.editId,
    offset: entry.offset + start,
    quote: entry.text.slice(start, end),
  };
}

/** Only mechanical defaults. The scenario declares observations, branch states and match judgments. */
export function captureRecord(
  key: string,
  observations: CaptureRecord['observations'],
  states: CaptureRecord['states'],
  options: Pick<Partial<CaptureRecord>, 'ambiguous' | 'candidates'> = {},
): CaptureRecord {
  return { key, observations, states, ambiguous: false, candidates: [], ...options };
}

export function captureDisposition(
  records: string[],
  submission: CaptureDisposition['submission'],
  reason: string,
): CaptureDisposition {
  return { records, submission, reason };
}

export type CaptureScenario = (review: {
  /** Delivered fragments in original branch/edit order, not merged or interpreted. */
  evidence: EvidencePageEntry[];
  /** Explicit bounded task/proposal/context requests. Follow returned cursors in the scenario. */
  lookup<T = unknown>(
    name: 'remembrancer_tasks' | 'remembrancer_proposals' | 'remembrancer_context',
    args: object,
  ): Promise<T>;
}) => CaptureSubmission | Promise<CaptureSubmission>;

/** runReviewer mock implementation: guidance, every evidence page, explicit scenario, one submit.
 * This bypasses the SDK, not the capture tools. SDK delivery/budget tests must use the real runner.
 */
export async function answerCaptureReview(
  input: ContinuingReviewerInput,
  scenario: CaptureScenario,
): Promise<void> {
  let sequence = 0;
  const call = async (name: string, args: object) => {
    const tool = input.tools.find((tool) => tool.name === name);
    if (!tool) throw new Error(`Missing fixture tool ${name}`);
    const result = await tool.execute(
      `fixture-${sequence++}`,
      args,
      input.signal,
      undefined,
      {} as Parameters<typeof tool.execute>[4],
    );
    input.acceptToolResult?.(result);
    return result.content.map((part) => (part.type === 'text' ? part.text : '')).join('');
  };
  const paths = reviewerPaths(input.instruction);
  await call('remembrancer_read', { path: paths.skill });
  const evidence: EvidencePageEntry[] = [];
  for (let page = 0; ; page++) {
    const data = JSON.parse(
      await call('remembrancer_read', { path: paths.review, page }),
    ) as EvidencePage;
    for (const { entries, ...group } of data.groups)
      for (const entry of entries) evidence.push({ ...group, ...entry });
    if (!data.hasMore) break;
  }
  const submission = await scenario({
    evidence,
    lookup: async <T>(name: string, args: object) => JSON.parse(await call(name, args)) as T,
  });
  await call('remembrancer_submit', submission);
}

/** SSE delta for writeCompletion(response, captureToolCalls(calls, turn), 'tool_calls'). */
export function captureToolCalls(calls: CaptureToolCall[], turn: number) {
  return {
    role: 'assistant',
    tool_calls: calls.map((call, index) => ({
      index,
      id: `call-${turn}-${index}`,
      type: 'function',
      function: { name: call.name, arguments: JSON.stringify(call.args) },
    })),
  };
}

import type { CreateAgentSessionOptions } from '@earendil-works/pi-coding-agent';

export interface ReviewerBudget {
  contextWindow: number;
  responseReserve: number;
  framingReserve: number;
  maxInputTokens: number;
}

export class ReviewerBudgetError extends Error {
  override name = 'ReviewerBudgetError';
}

/** Conservative estimate, not provider token accounting. Includes JSON escaping and Unicode. */
export function estimateReviewerTokens(value: unknown): number {
  const json = JSON.stringify(value);
  if (json === undefined) throw new ReviewerBudgetError('Reviewer input is not serializable');
  // One token per UTF-8 byte deliberately overestimates ordinary text and schemas.
  return Buffer.byteLength(json, 'utf8');
}

export function getReviewerBudget(
  model: NonNullable<CreateAgentSessionOptions['model']>,
): ReviewerBudget {
  const { contextWindow, maxTokens } = model;
  if (
    !Number.isSafeInteger(contextWindow) ||
    contextWindow <= 0 ||
    !Number.isSafeInteger(maxTokens) ||
    maxTokens <= 0
  ) {
    throw new ReviewerBudgetError('Reviewer requires positive model contextWindow and maxTokens');
  }
  // Reserve the entire declared response ceiling, including thinking. Do not rely
  // on provider defaults, observed usage, or Pi's less conservative context estimate.
  const responseReserve = maxTokens;
  // Leave additional room for provider framing and a small host handoff envelope.
  const framingReserve = Math.max(1024, Math.ceil(contextWindow * 0.05));
  const maxInputTokens = contextWindow - responseReserve - framingReserve;
  const budget = { contextWindow, responseReserve, framingReserve, maxInputTokens };
  assertReviewerFits(budget, 1, 'minimum framing and response reserve');
  return budget;
}

export function assertReviewerFits(budget: ReviewerBudget, tokens: number, label: string): void {
  if (tokens > budget.maxInputTokens) {
    throw new ReviewerBudgetError(
      `Reviewer ${label} exceeds context budget (${tokens} estimated input tokens, ` +
        `${budget.maxInputTokens} available after response/thinking and framing reserves). ` +
        'Split the input or hand off host-owned state to a fresh reviewer step.',
    );
  }
}

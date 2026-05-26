const SKIP_REASON_HINTS: Record<string, string> = {
  'missing context window':
    "Add a local contextWindow override with '/openrouter model-override-set <model-id> contextWindow=<tokens>' if the model's limit is known.",
  'missing max tokens':
    "Add a local maxTokens override with '/openrouter model-override-set <model-id> maxTokens=<tokens>' if the model's completion limit is known.",
  'missing prompt pricing':
    'OpenRouter did not provide complete pricing metadata, so Pi cannot map model cost safely.',
  'missing completion pricing':
    'OpenRouter did not provide complete pricing metadata, so Pi cannot map model cost safely.',
  'non-text output modalities':
    'This sync only registers models that advertise text/chat output, so non-text-only models are skipped.',
};

/**
 * Return an optional human-readable hint for a stable machine-readable skip reason.
 */
export function getSkipReasonHint(reason: string): string | undefined {
  return SKIP_REASON_HINTS[reason];
}

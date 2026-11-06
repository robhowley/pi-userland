import { keyHint, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { TSchema } from '@earendil-works/pi-ai';
import { Text, stripTerminalSequences } from '@earendil-works/pi-tui';
import type { WarningRecord } from './warnings.js';

export type ReviewAction = 'begin' | 'next' | 'context' | 'finish' | 'cancel';

export type ReviewResultDetails = {
  action: ReviewAction;
  batch: string;
  seed?: string;
  requestedSince?: string;
  incomplete: boolean;
  warnings: WarningRecord[];
  coverageChanged: boolean;
};

type ReviewToolDefinition = ToolDefinition<TSchema, ReviewResultDetails>;
type ReviewRenderCall = NonNullable<ReviewToolDefinition['renderCall']>;
type ReviewRenderResult = NonNullable<ReviewToolDefinition['renderResult']>;

type ResultPayload = Record<string, unknown>;
type EvidenceEntry = {
  text?: unknown;
  role?: unknown;
  timestamp?: unknown;
  sessionId?: unknown;
  branchId?: unknown;
  entryId?: unknown;
  editId?: unknown;
  file?: unknown;
  cwd?: unknown;
  reviewedThrough?: unknown;
  offset?: unknown;
  continues?: unknown;
};

type RendererContext = Parameters<ReviewRenderResult>[3];
type ContextWithKeyHint = RendererContext & {
  keyHint?: (keybinding: string, description: string) => string;
};

const REVIEW_ACTIONS: readonly ReviewAction[] = ['begin', 'next', 'context', 'finish', 'cancel'];

/** Remove terminal control input while retaining line breaks for Text wrapping. */
export function sanitizeText(value: string): string {
  return Array.from(stripTerminalSequences(value), (character) => {
    const codePoint = character.codePointAt(0);
    const isControl =
      codePoint !== undefined &&
      (codePoint <= 0x08 ||
        codePoint === 0x0b ||
        codePoint === 0x0c ||
        (codePoint >= 0x0e && codePoint <= 0x1f) ||
        (codePoint >= 0x7f && codePoint <= 0x9f));
    return isControl ? ' ' : character;
  }).join('');
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function abbreviateSessionId(value: string): string {
  return value.length > 8 ? `${value.slice(0, 8)}…` : value;
}

function actionValue(value: unknown): ReviewAction | undefined {
  return typeof value === 'string' && REVIEW_ACTIONS.includes(value as ReviewAction)
    ? (value as ReviewAction)
    : undefined;
}

function detailsValue(value: unknown): ReviewResultDetails | undefined {
  const candidate = record(value);
  if (!candidate) return undefined;
  const action = actionValue(candidate['action']);
  if (!action || typeof candidate['batch'] !== 'string') return undefined;
  if (
    typeof candidate['incomplete'] !== 'boolean' ||
    !Array.isArray(candidate['warnings']) ||
    !candidate['warnings'].every(isWarningRecord)
  )
    return undefined;
  return candidate as unknown as ReviewResultDetails;
}

function resultText(result: { content: readonly unknown[] }): string {
  return result.content
    .map((item) => {
      const content = record(item);
      return content?.['type'] === 'text' && typeof content['text'] === 'string'
        ? content['text']
        : '';
    })
    .filter(Boolean)
    .join('\n');
}

function parsePayload(text: string): ResultPayload | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    return record(parsed);
  } catch {
    return undefined;
  }
}

function formatCount(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function countValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function entryCount(payload: ResultPayload): number {
  return Array.isArray(payload['entries']) ? payload['entries'].length : 0;
}

function hasMore(payload: ResultPayload): boolean {
  return payload['hasMore'] === true;
}

function compactSummary(payload: ResultPayload, details: ReviewResultDetails): string {
  const entries = entryCount(payload);

  switch (details.action) {
    case 'begin': {
      if (entries > 0)
        return `${formatCount(entries, 'excerpt')} · ${formatCount(countValue(payload['capturedTips']), 'branch tip')} · ${hasMore(payload) ? 'more evidence' : 'last evidence page'}`;
      if (payload['coverageChanged'] === true || payload['status'] === 'coverage-pending')
        return 'No new evidence · new coverage to save';
      if (details.incomplete || payload['status'] === 'incomplete')
        return 'No evidence available · review still open';
      return 'Nothing new · review still open';
    }
    case 'next':
      if (entries > 0)
        return `${formatCount(entries, 'excerpt')} · ${hasMore(payload) ? 'more evidence' : 'last evidence page'}`;
      return 'No more evidence · review still open';
    case 'context':
      if (entries === 0) return 'No preceding context';
      return `${formatCount(entries, 'prior excerpt')} · context only · ${payload['nextOffset'] === null ? 'end of context' : 'more context'}`;
    case 'finish': {
      const tips = countValue(payload['reviewedTips']);
      if (details.incomplete || payload['status'] === 'partial')
        return `Finished available sources · ${formatCount(tips, 'branch tip')} recorded`;
      if (payload['status'] === 'already-covered' || payload['coverageChanged'] === false)
        return 'Finished · no coverage changes';
      if (
        payload['status'] === 'coverage-finished' ||
        payload['coverageChanged'] === true ||
        (details.coverageChanged && tips === 0)
      )
        return `Finished · coverage saved · ${formatCount(tips, 'branch tip')}`;
      if (details.coverageChanged === false) return 'Finished · no coverage changes';
      return `Finished · ${formatCount(tips, 'branch tip')} recorded`;
    }
    case 'cancel':
      return 'Cancelled · review progress not saved';
  }
}

function warningLine(details: ReviewResultDetails): string | undefined {
  const count = details.warnings.length;
  if (count === 0) return undefined;
  const hasBlockingWarning = details.warnings.some(
    (warning) => warning.kind !== 'unknown-timestamp',
  );
  return hasBlockingWarning || details.incomplete
    ? `! Some sources could not be reviewed · ${formatCount(count, 'warning')}`
    : `! ${formatCount(count, 'warning')} · source coverage complete`;
}

function warningEffect(kind: WarningRecord['kind']): string {
  switch (kind) {
    case 'source-failure':
      return 'This source remains unreviewed.\nAvailable sources can still be reviewed and finished.';
    case 'archive-scan':
      return 'This archive was not fully scanned.\nAvailable sources can still be reviewed and finished.';
    case 'identity-ambiguity':
      return 'The source identity is ambiguous, so it remains unreviewed.\nAvailable sources can still be reviewed and finished.';
    case 'unknown-timestamp':
      return 'The timestamp is unknown, but this does not make coverage incomplete.';
  }
}

function isWarningKind(value: unknown): value is WarningRecord['kind'] {
  return (
    value === 'source-failure' ||
    value === 'archive-scan' ||
    value === 'identity-ambiguity' ||
    value === 'unknown-timestamp'
  );
}

function isWarningRecord(value: unknown): value is WarningRecord {
  const candidate = record(value);
  return Boolean(
    candidate &&
    typeof candidate['message'] === 'string' &&
    Array.isArray(candidate['sources']) &&
    candidate['sources'].every((source) => typeof source === 'string') &&
    typeof candidate['reason'] === 'string' &&
    isWarningKind(candidate['kind']),
  );
}

function indent(value: string, prefix: string): string {
  return sanitizeText(value)
    .split('\n')
    .map((line) => `${prefix}${line}`)
    .join('\n');
}

function styled(
  theme: Parameters<ReviewRenderResult>[2],
  color: Parameters<typeof theme.fg>[0],
  value: string,
): string {
  return theme.fg(color, sanitizeText(value));
}

function appendWarningBlocks(
  lines: string[],
  warnings: readonly WarningRecord[],
  theme: Parameters<ReviewRenderResult>[2],
): void {
  for (const warning of warnings) {
    lines.push('');
    lines.push(`  ${theme.bold('Source')}`);
    for (const source of warning.sources) lines.push(`    ${sanitizeText(source)}`);
    lines.push('');
    lines.push(`  ${theme.bold('Error')}`);
    lines.push(indent(warning.reason, '    '));
    lines.push('');
    lines.push(`  ${theme.bold('Effect')}`);
    lines.push(indent(warningEffect(warning.kind), '    '));
  }
}

function appendEvidenceBlocks(
  lines: string[],
  entries: readonly unknown[],
  contextOnly: boolean,
  theme: Parameters<ReviewRenderResult>[2],
): void {
  for (const [index, value] of entries.entries()) {
    const entry = record(value) as EvidenceEntry | undefined;
    lines.push('');
    lines.push(`  ${theme.bold(`${contextOnly ? 'Context' : 'Evidence'} ${index + 1}`)}`);
    lines.push(`    role: ${sanitizeText(String(entry?.role ?? 'unknown'))}`);
    lines.push(`    timestamp: ${sanitizeText(String(entry?.timestamp ?? 'unknown'))}`);
    lines.push(`    sessionId: ${sanitizeText(String(entry?.sessionId ?? 'unknown'))}`);
    lines.push(`    branchId: ${sanitizeText(String(entry?.branchId ?? 'unknown'))}`);
    lines.push(`    entryId: ${sanitizeText(String(entry?.entryId ?? 'unknown'))}`);
    lines.push(`    editId: ${sanitizeText(String(entry?.editId ?? 'none'))}`);
    lines.push(`    source: ${sanitizeText(String(entry?.file ?? 'unknown'))}`);
    lines.push(`    cwd: ${sanitizeText(String(entry?.cwd ?? 'unknown'))}`);
    lines.push(`    reviewedThrough: ${sanitizeText(String(entry?.reviewedThrough ?? 'none'))}`);
    lines.push(`    offset: ${sanitizeText(String(entry?.offset ?? 0))}`);
    lines.push(`    continues: ${entry?.continues === true ? 'true' : 'false'}`);
    lines.push('    text:');
    lines.push(indent(String(entry?.text ?? ''), '      '));
    if (contextOnly) lines.push('    interpretation only: true');
  }
}

function appendBatchDetails(
  lines: string[],
  details: ReviewResultDetails,
  theme: Parameters<ReviewRenderResult>[2],
): void {
  lines.push('');
  lines.push(`  ${theme.bold('Batch')}`);
  lines.push(`    token: ${sanitizeText(details.batch)}`);
  lines.push(`    seed: ${sanitizeText(stringValue(details.seed) ?? 'none')}`);
  lines.push(`    requestedSince: ${sanitizeText(stringValue(details.requestedSince) ?? 'none')}`);
}

function appendArgumentLines(lines: string[], value: unknown, prefix = ''): void {
  const object = record(value);
  if (object && !Array.isArray(value)) {
    const entries = Object.entries(object);
    if (entries.length === 0) {
      lines.push(indent(prefix ? `${prefix}: {}` : '{}', '    '));
      return;
    }
    for (const [key, child] of entries) {
      const path = prefix ? `${prefix}.${key}` : key;
      if (record(child) && !Array.isArray(child)) appendArgumentLines(lines, child, path);
      else {
        const rendered = typeof child === 'string' ? child : String(child);
        lines.push(indent(`${path}: ${rendered}`, '    '));
      }
    }
    return;
  }

  lines.push(indent(`${prefix}: ${String(value)}`, '    '));
}

function appendArguments(
  lines: string[],
  args: unknown,
  theme: Parameters<ReviewRenderResult>[2],
): void {
  if (!record(args)) return;
  lines.push('');
  lines.push(`  ${theme.bold('Arguments')}`);
  appendArgumentLines(lines, args);
}

function expansionHint(context: RendererContext): string {
  const configured = (context as ContextWithKeyHint).keyHint;
  if (typeof configured === 'function') return configured('app.tools.expand', 'to expand');
  try {
    return keyHint('app.tools.expand', 'to expand');
  } catch {
    return 'to expand';
  }
}

function rawResultComponent(
  raw: string,
  expanded: boolean,
  theme: Parameters<ReviewRenderResult>[2],
  context: RendererContext,
): Text {
  const safe = sanitizeText(raw);
  const text = safe || 'No result content';
  if (!expanded)
    return new Text(`${text}\n${theme.fg('dim', sanitizeText(expansionHint(context)))}`, 0, 0);

  const lines = [text];
  appendArguments(lines, context.args, theme);
  return new Text(lines.join('\n'), 0, 0);
}

function errorComponent(
  action: ReviewAction,
  raw: string,
  expanded: boolean,
  args: unknown,
  theme: Parameters<ReviewRenderResult>[2],
): Text {
  const lines = [theme.fg('error', sanitizeText(`Could not ${action}`))];
  if (raw) lines.push(sanitizeText(raw));
  if (expanded) appendArguments(lines, args, theme);
  return new Text(lines.join('\n'), 0, 0);
}

export const renderReviewCall: ReviewRenderCall = (args, theme) => {
  const input = record(args);
  const parameters: string[] = [];
  const action = stringValue(input?.['action']);
  if (action !== undefined) parameters.push(`action=${sanitizeText(action)}`);

  const seed = stringValue(input?.['seed']);
  if (seed !== undefined) parameters.push(`seed=${sanitizeText(seed)}`);

  if (action === 'context') {
    const selected = record(input?.['selected']);
    const sessionId = stringValue(selected?.['sessionId']);
    if (sessionId !== undefined)
      parameters.push(`selected.sessionId=${abbreviateSessionId(sanitizeText(sessionId))}`);
  }

  const parameterText = parameters.length > 0 ? `(${parameters.join(', ')})` : '';
  return new Text(
    `${theme.fg('toolTitle', theme.bold('remembrancer_review'))}${parameterText}`,
    0,
    0,
  );
};

export const renderReviewResult: ReviewRenderResult = (result, options, theme, context) => {
  const raw = resultText(result);
  const details = detailsValue(result.details);
  const action = details?.action ?? actionValue(record(context.args)?.['action']) ?? 'begin';

  if (options.isPartial)
    return new Text(theme.fg('warning', sanitizeText(`Pending · ${action}`)), 0, 0);
  if (context.isError) return errorComponent(action, raw, options.expanded, context.args, theme);
  if (!details) return rawResultComponent(raw, options.expanded, theme, context);

  const payload = parsePayload(raw);
  if (!payload) return rawResultComponent(raw, options.expanded, theme, context);

  const summary = compactSummary(payload, details);
  const warningText = warningLine(details);
  const lines = [styled(theme, 'toolOutput', summary)];
  if (warningText) lines.push(styled(theme, 'warning', warningText));

  if (!options.expanded) {
    lines.push(styled(theme, 'dim', expansionHint(context)));
    return new Text(lines.join('\n'), 0, 0);
  }

  appendWarningBlocks(lines, details.warnings, theme);
  appendEvidenceBlocks(
    lines,
    Array.isArray(payload['entries']) ? payload['entries'] : [],
    payload['contextOnly'] === true,
    theme,
  );
  if (details.action === 'cancel') {
    lines.push('');
    lines.push('  Previously applied Taskwarrior changes were not undone.');
  }
  appendBatchDetails(lines, details, theme);
  appendArguments(lines, context.args, theme);
  return new Text(lines.join('\n'), 0, 0);
};

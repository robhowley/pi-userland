import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { matchesKey, SelectList, Text } from '@earendil-works/pi-tui';
import type { CheckpointStore } from './checkpoints.js';
import { type Proposal, type ProposalDraft, validateDraft } from './proposals.js';
import {
  applyProposal,
  previewProposal,
  requireTui,
  resolveProposal,
  type TaskExecutor,
  type TaskPreview,
} from './taskwarrior.js';

// JSON escapes control characters so saved evidence cannot issue terminal commands.
const exact = (value: unknown) => JSON.stringify(value ?? null);
function project(proposal: Proposal): string {
  const draft = proposal.draft ?? proposal;
  return (
    (draft.change.operation !== 'complete' ? draft.change.fields.project : undefined) ??
    draft.expected?.fields.project ??
    '(no project)'
  );
}
export function sourceText(proposal: Proposal): string {
  return (
    proposal.sources
      .map(
        (source) =>
          `${source.role} ${exact(source.timestamp)} ${exact(source.locator)}\n${exact(source.quote)}\nFile: ${exact(source.file)}\nSession: ${exact(source.sessionId)}\nBranch: ${exact(source.branchId)}\nEntry: ${exact(source.entryId)}\nEdit: ${exact(source.editId)}\nExcerpt offset: ${source.offset}`,
      )
      .join('\n\n') +
    '\n\nSaved excerpts only. Extra file context is unavailable in this view; no session switch or archive scan.'
  );
}
export function previewText(preview: TaskPreview): string {
  const { proposal, task } = preview;
  const draft = proposal.draft ?? proposal;
  const change = draft.change;
  const state =
    proposal.state === 'applying' ? 'uncertain (unresolved applying claim)' : proposal.state;
  const lines = [
    `${change.operation.toUpperCase()} · ${state} · revision ${proposal.revision}`,
    `Target: ${change.operation === 'add' ? (proposal.claim ?? '(new task)') : change.targetUuid}`,
    `Description: ${exact(change.operation !== 'complete' && change.fields.description !== undefined ? change.fields.description : (task?.['description'] ?? draft.expected?.fields.description))}`,
    `Project: ${exact(project(proposal))}`,
  ];
  if (change.operation !== 'complete')
    for (const [field, value] of Object.entries(change.fields))
      lines.push(`${field}: ${exact(task?.[field])} -> ${exact(value)}`);
  lines.push(
    `status: ${exact(task?.['status'])} -> ${exact(change.operation === 'complete' ? 'completed' : (task?.['status'] ?? 'pending'))}`,
  );
  lines.push(
    `annotations: ${exact(task?.['annotations'] ?? [])}`,
    `Append annotations (existing identical text is retained): ${exact(change.annotations)}`,
  );
  if (draft.question) lines.push(`Apply disabled: ${exact(draft.question)}`);
  if (change.operation !== 'add' && !task) lines.push('Apply disabled: target missing');
  lines.push(
    `Why: ${exact(proposal.explanation)}`,
    ...proposal.sources.map(
      (source) =>
        `${source.role} ${exact(source.timestamp)} ${exact(source.locator)}: ${exact(source.quote)}`,
    ),
  );
  if (proposal.result) lines.push(`Result: ${exact(proposal.result)}`);
  if (['applying', 'uncertain'].includes(proposal.state))
    lines.push(
      'No replay. Ctrl+A only verifies the current task and records already satisfied if it matches. Otherwise resolve the task manually.',
    );
  return lines.join('\n');
}
export async function openProposals(
  ctx: ExtensionContext,
  store: CheckpointStore,
  execute?: TaskExecutor,
): Promise<void> {
  requireTui(ctx.mode);
  let selected = 0;
  let selectedId: string | undefined;
  let message = '';
  for (;;) {
    requireTui(ctx.mode);
    const proposals: Proposal[] = [];
    for (let offset = 0; ; offset += 50) {
      const page = store.proposals(undefined, offset, 50);
      proposals.push(...page);
      if (page.length < 50) break;
    }
    proposals.sort(
      (a, b) =>
        project(a).localeCompare(project(b)) ||
        a.createdAt.localeCompare(b.createdAt) ||
        a.id.localeCompare(b.id),
    );
    if (!proposals.length) {
      ctx.ui.notify('No task proposals', 'info');
      return;
    }
    if (selectedId)
      selected = Math.max(
        0,
        proposals.findIndex((item) => item.id === selectedId),
      );
    selected = Math.min(selected, proposals.length - 1);
    const proposal = proposals[selected]!;
    selectedId = proposal.id;
    let preview: TaskPreview | undefined;
    let previewError = '';
    try {
      preview = await previewProposal(store, proposal.id, execute);
    } catch (error) {
      previewError = String(error);
    }
    const action = await ctx.ui.custom<'apply' | 'edit' | 'dismiss' | 'navigate' | 'close'>(
      (tui, theme, kb, done) => {
        let source = false;
        let scroll = 0;
        let total = 0;
        const list = new SelectList(
          proposals.map((item) => {
            const change = (item.draft ?? item).change;
            return {
              value: item.id,
              label: `${exact(project(item))} · ${change.operation} · ${item.state === 'applying' ? 'uncertain' : item.state}`,
              description: exact(
                change.operation !== 'complete'
                  ? (change.fields.description ?? (item.draft ?? item).expected?.fields.description)
                  : (item.draft ?? item).expected?.fields.description,
              ),
            };
          }),
          5,
          {
            selectedPrefix: (s) => theme.fg('accent', s),
            selectedText: (s) => theme.fg('accent', s),
            description: (s) => theme.fg('muted', s),
            scrollInfo: (s) => theme.fg('dim', s),
            noMatch: (s) => s,
          },
        );
        list.setSelectedIndex(selected);
        list.onSelectionChange = (item) => {
          selectedId = item.value;
          done('navigate');
        };
        list.onCancel = () => done('close');
        return {
          capturesViewportInput: true,
          render(width: number) {
            const body = new Text(
              source
                ? sourceText(proposal)
                : preview
                  ? previewText(preview)
                  : `${exact(previewError)}\n${sourceText(proposal)}`,
              0,
              0,
            ).render(width);
            total = body.length;
            scroll = Math.max(0, Math.min(scroll, Math.max(0, total - 12)));
            return [
              ...new Text(theme.fg('accent', 'Task proposals'), 0, 0).render(width),
              ...list.render(width),
              ...body.slice(scroll, scroll + 12),
              ...new Text(
                theme.fg(
                  'dim',
                  `Details ${scroll + 1}-${Math.min(scroll + 12, total)}/${total} · PgUp/PgDn scroll\nCtrl+A Apply / verify unresolved · e Edit · d Dismiss · s Source · Esc close\nEnter never applies. ${message ? exact(message) : ''}`,
                ),
                0,
                0,
              ).render(width),
            ];
          },
          invalidate() {
            list.invalidate();
          },
          handleInput(data: string) {
            if (matchesKey(data, 'pageDown')) scroll += 12;
            else if (matchesKey(data, 'pageUp')) scroll -= 12;
            else if (data === 's') {
              source = !source;
              scroll = 0;
            } else if (source && kb.matches(data, 'tui.select.cancel')) {
              source = false;
              scroll = 0;
            } else if (!source && matchesKey(data, 'ctrl+a')) done('apply');
            else if (!source && data === 'e') done('edit');
            else if (!source && data === 'd') done('dismiss');
            else if (!kb.matches(data, 'tui.select.confirm')) list.handleInput(data);
            tui.requestRender();
          },
        };
      },
    );
    if (action === 'close') return;
    message = '';
    try {
      requireTui(ctx.mode);
      if (action === 'apply') {
        if (!preview) throw new Error(previewError);
        const resolved = ['applying', 'uncertain'].includes(preview.proposal.state)
          ? await resolveProposal(store, preview, () => ctx.mode, execute)
          : await applyProposal(store, preview, () => ctx.mode, execute);
        message = resolved.state;
        if (['applied', 'already_satisfied'].includes(resolved.state))
          selectedId = proposals[Math.min(selected + 1, proposals.length - 1)]!.id;
      } else if (action === 'dismiss') store.dismissProposal(proposal.id, proposal.revision);
      else if (action === 'edit') {
        if (proposal.state !== 'pending')
          throw new Error(
            'Only pending proposals can be edited. Unresolved writes are never retried.',
          );
        const draft = proposal.draft ?? proposal;
        const text = await ctx.ui.editor(
          'Edit proposal JSON (save draft only; dates use YYYYMMDDTHHMMSSZ)',
          JSON.stringify(
            { change: draft.change, expected: draft.expected, question: draft.question },
            null,
            2,
          ),
        );
        if (text !== undefined) {
          const edited = JSON.parse(text) as ProposalDraft;
          validateDraft(edited);
          store.editProposal(proposal.id, proposal.revision, edited);
          message = 'Draft saved. Review the new preview before applying.';
        }
      }
    } catch (error) {
      message = String(error);
    }
  }
}

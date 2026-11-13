import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { matchesKey, SelectList, Text } from '@earendil-works/pi-tui';
import type { CheckpointStore } from './checkpoints.js';
import { branchEvidence, readSession } from './evidence.js';
import { boundedEvidencePage } from './review-pages.js';
import { type Proposal, type ProposalDraft, validateDraft } from './proposals.js';
import {
  applyProposal,
  previewProposal,
  requireTui,
  resolveProposal,
  type TaskExecutor,
  type TaskPreview,
} from './taskwarrior.js';

// JSON preserves exact values without sending terminal controls (including C1) to the TUI.
function exact(value: unknown, indent?: number): string {
  return Array.from(JSON.stringify(value ?? null, null, indent), (character) => {
    const code = character.charCodeAt(0);
    return code >= 0x7f && code <= 0x9f ? `\\u${code.toString(16).padStart(4, '0')}` : character;
  }).join('');
}
function project(proposal: Proposal): string {
  const draft = proposal.draft ?? proposal;
  return (
    (draft.change.operation !== 'complete' && draft.change.fields.project !== undefined
      ? draft.change.fields.project
      : draft.expected?.fields.project) ?? '(no project)'
  );
}
function savedSourceText(source: Proposal['sources'][number]): string {
  return `${source.role} ${exact(source.timestamp)} ${exact(source.locator)}\n${exact(source.quote)}\nFile: ${exact(source.file)}\nSession: ${exact(source.sessionId)}\nBranch: ${exact(source.branchId)}\nEntry: ${exact(source.entryId)}\nEdit: ${exact(source.editId)}\nExcerpt offset: ${source.offset}`;
}
// Called only by the deliberate Source action, never while rendering a preview.
export function sourceText(proposal: Proposal): string {
  return proposal.sources
    .map((source) => {
      const saved = savedSourceText(source);
      try {
        const tree = readSession(source.file);
        const branch = branchEvidence(tree, {
          file: source.file,
          sessionId: source.sessionId,
          entryId: source.branchId,
        });
        const index = branch.findIndex(
          (item) => item.entryId === source.entryId && item.editId === source.editId,
        );
        const selected = branch[index];
        if (
          !selected ||
          selected.role !== source.role ||
          selected.timestamp !== source.timestamp ||
          selected.text.slice(source.offset, source.offset + source.quote.length) !== source.quote
        )
          throw new Error('Saved reference no longer matches');
        const surrounding = branch.slice(Math.max(0, index - 2), index + 3);
        const page = boundedEvidencePage(surrounding, { index: 0, offset: 0 }, (entries) => ({
          entries,
        }));
        return `${saved}\n\nLocal context (up to two messages before and after, saved branch):\n${exact(page.data)}${page.cursor.index < surrounding.length ? '\nAdditional context omitted at the display limit.' : ''}`;
      } catch {
        return `${saved}\n\nExtra file context is unavailable: source missing, unreadable, over limits, or saved reference no longer matches.`;
      }
    })
    .join('\n\n');
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
    `Project: ${exact(change.operation !== 'complete' && change.fields.project !== undefined ? change.fields.project : (task?.['project'] ?? '(no project)'))}`,
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
  lines.push(`Current task: ${exact(task)}`);
  if (proposal.draft)
    lines.push('Edited draft. Press h for the saved proposal and revision history.');
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
        let detail: 'preview' | 'source' | 'history' = 'preview';
        let sourceBody = '';
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
              detail === 'source'
                ? sourceBody
                : detail === 'history'
                  ? `Saved proposal and revision history (drafts do not apply tasks):\n${exact(proposal, 2)}`
                  : preview
                    ? previewText(preview)
                    : `${exact(previewError)}\n${proposal.sources.map(savedSourceText).join('\n\n')}`,
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
                  `Details ${scroll + 1}-${Math.min(scroll + 12, total)}/${total} · PgUp/PgDn scroll\nCtrl+A Apply / verify unresolved · e Edit · d Dismiss · s Source · h History · Esc back/close\nEnter never applies. ${message ? exact(message) : ''}`,
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
              detail = detail === 'source' ? 'preview' : 'source';
              if (detail === 'source') sourceBody = sourceText(proposal);
              scroll = 0;
            } else if (data === 'h') {
              detail = detail === 'history' ? 'preview' : 'history';
              scroll = 0;
            } else if (detail !== 'preview' && kb.matches(data, 'tui.select.cancel')) {
              detail = 'preview';
              scroll = 0;
            } else if (detail === 'preview' && matchesKey(data, 'ctrl+a')) done('apply');
            else if (detail === 'preview' && data === 'e') done('edit');
            else if (detail === 'preview' && data === 'd') done('dismiss');
            else if (detail === 'preview' && !kb.matches(data, 'tui.select.confirm'))
              list.handleInput(data);
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
          exact({ change: draft.change, expected: draft.expected, question: draft.question }, 2),
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

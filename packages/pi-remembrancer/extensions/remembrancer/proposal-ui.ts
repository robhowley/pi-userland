import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import {
  matchesKey,
  sliceByColumn,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from '@earendil-works/pi-tui';
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
function title(proposal: Proposal): string {
  const draft = proposal.draft ?? proposal;
  return (
    (draft.change.operation !== 'complete' ? draft.change.fields.description : undefined) ??
    draft.expected?.fields.description ??
    '(untitled task)'
  );
}
function decided(proposal: Proposal): boolean {
  return ['applied', 'already_satisfied', 'dismissed'].includes(proposal.state);
}
function savedSourceText(source: Proposal['sources'][number]): string {
  return `${exact(source.role)} ${exact(source.timestamp)} ${exact(source.locator)}\n${exact(source.quote)}\nFile: ${exact(source.file)}\nSession: ${exact(source.sessionId)}\nBranch: ${exact(source.branchId)}\nEntry: ${exact(source.entryId)}\nEdit: ${exact(source.editId)}\nExcerpt offset: ${source.offset}`;
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
function savedReviewText(proposal: Proposal): string {
  return [
    `Saved title (not live verification): ${exact(title(proposal))}`,
    `Why: ${exact(proposal.explanation)}`,
    'Saved quotes:',
    ...proposal.sources.map(
      (source) =>
        `${exact(source.role)} ${exact(source.timestamp)} ${exact(source.locator)}: ${exact(source.quote)}`,
    ),
  ].join('\n');
}
export function previewText(preview: TaskPreview): string {
  const { proposal, task } = preview;
  const draft = proposal.draft ?? proposal;
  const change = draft.change;
  const unresolved = ['applying', 'uncertain'].includes(proposal.state);
  const status =
    change.operation === 'complete'
      ? 'completed'
      : unresolved
        ? (proposal.applicationBefore?.status ?? draft.expected?.status ?? 'pending')
        : (task?.['status'] ?? 'pending');
  const lines = [
    `${change.operation.toUpperCase()} · ${exact(proposal.state)} · revision ${proposal.revision}`,
    `Proposal ID: ${exact(proposal.id)}`,
    `Target UUID: ${exact(change.operation === 'add' ? (proposal.claim ?? '(new task)') : change.targetUuid)}`,
  ];
  if (task) {
    lines.push(
      `Current UUID: ${exact(task['uuid'])}`,
      `Current task ID: ${exact(task['id'])}`,
      `Current description: ${exact(task['description'])}`,
      `Project: ${exact(task['project'] ?? '(no project)')} (current)`,
    );
  } else if (change.operation === 'add') lines.push('New task. No current target.');
  else lines.push('Apply disabled: target missing');
  if (draft.expected)
    lines.push(
      `Saved fallback description (not current): ${exact(draft.expected.fields.description)}`,
      `Saved fallback project (not current): ${exact(draft.expected.fields.project)}`,
    );
  lines.push('Exact changes (current -> proposed replacement):');
  if (change.operation !== 'complete')
    for (const [field, value] of Object.entries(change.fields))
      lines.push(`${field}: ${exact(task?.[field])} -> ${exact(value)}`);
  lines.push(
    `status: ${exact(task?.['status'])} -> ${exact(status)}`,
    'Unmentioned fields are retained. Null clears the named field.',
    'Append annotations (existing identical text is retained; no semantic deduplication):',
    ...change.annotations.map((annotation, index) => `${index + 1}. ${exact(annotation)}`),
  );
  if (!change.annotations.length) lines.push('(none)');
  if (draft.question) lines.push(`Apply disabled: ${exact(draft.question)}`);
  lines.push(savedReviewText(proposal));
  if (proposal.draft)
    lines.push('Edited draft. Press h for the saved proposal and revision history.');
  if (proposal.result) {
    lines.push(`Result: ${exact(proposal.result.state)}`);
    if (proposal.result.error) lines.push(`Result error: ${exact(proposal.result.error)}`);
  }
  if (unresolved)
    lines.push(
      'Unresolved write. No replay. Ctrl+A is verification only: records already satisfied if the requested result is present. Otherwise resolve the task manually.',
    );
  return lines.join('\n');
}

export async function openProposals(
  ctx: ExtensionContext,
  store: CheckpointStore,
  execute?: TaskExecutor,
): Promise<void> {
  requireTui(ctx.mode);
  let proposals: Proposal[] = [];
  let selected = 0;
  let expanded = false;
  let preview: TaskPreview | undefined;
  let previewError = '';
  let loading = false;
  let request = 0;
  let message = '';
  type View = 'inbox' | 'source' | 'history' | 'inspection';
  let view: View = 'inbox';
  const offsets: Record<View, number> = { inbox: 0, source: 0, history: 0, inspection: 0 };
  let sourceBody = '';
  let historySelected = 0;
  let historyEntries: { section: string; proposal: Proposal }[] = [];

  function reload() {
    proposals = [];
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
  }
  const inbox = () => proposals.filter((proposal) => !decided(proposal));
  function collapse() {
    expanded = false;
    preview = undefined;
    previewError = '';
    loading = false;
    request++;
    offsets.inbox = 0;
  }
  reload();
  for (;;) {
    requireTui(ctx.mode);
    const action = await ctx.ui.custom<'edit' | 'close'>(
      (tui, theme, kb, done) => {
        let active = true;
        let busy = false;
        let pageSize = 1;
        let lastWidth = 1;
        let viable = false;
        let reveal = true;

        async function loadPreview() {
          const proposal = inbox()[selected];
          if (!proposal) return;
          const token = ++request;
          const id = proposal.id;
          loading = true;
          preview = undefined;
          previewError = '';
          tui.requestRender();
          try {
            requireTui(ctx.mode);
            const loaded = await previewProposal(store, id, execute);
            if (!active || request !== token || !expanded || inbox()[selected]?.id !== id) return;
            preview = loaded;
          } catch (error) {
            if (!active || request !== token || !expanded || inbox()[selected]?.id !== id) return;
            previewError = String(error);
          } finally {
            if (active && request === token) {
              loading = false;
              tui.requestRender();
            }
          }
        }
        function expand() {
          expanded = true;
          offsets.inbox = 0;
          void loadPreview();
        }
        function openHistory() {
          const proposal = inbox()[selected];
          historyEntries = [
            ...(proposal
              ? [...(proposal.history ?? []), proposal].map((revision) => ({
                  section: 'Selected-proposal revisions',
                  proposal: revision,
                }))
              : []),
            ...proposals.filter(decided).map((item) => ({
              section: 'Decided proposals',
              proposal: item,
            })),
          ];
          historySelected = 0;
          offsets.history = 0;
          view = 'history';
          reveal = true;
        }
        // Only service/store results establish a decided outcome. An unresolved item stays here.
        function outcome(result: Proposal) {
          message =
            result.state === 'applied'
              ? 'Applied and verified.'
              : result.state === 'already_satisfied'
                ? 'Already satisfied. No task write performed.'
                : result.state === 'dismissed'
                  ? 'Dismissed. Task unchanged.'
                  : `Unresolved (${result.state}). No automatic retry; inspect the result.`;
          const id = result.id;
          reload();
          if (decided(result)) {
            selected = Math.max(0, Math.min(selected, inbox().length - 1));
            collapse();
            reveal = true;
          } else {
            selected = Math.max(
              0,
              inbox().findIndex((item) => item.id === id),
            );
          }
        }
        async function authorize() {
          if (!preview || loading || busy) return;
          const approved = preview;
          busy = true;
          message = ['applying', 'uncertain'].includes(approved.proposal.state)
            ? 'Verifying only. No write will be replayed.'
            : 'Applying this proposal and verifying the result…';
          tui.requestRender();
          try {
            requireTui(ctx.mode);
            const result = ['applying', 'uncertain'].includes(approved.proposal.state)
              ? await resolveProposal(store, approved, () => ctx.mode, execute)
              : await applyProposal(store, approved, () => ctx.mode, execute);
            outcome(result);
          } catch (error) {
            message = String(error);
            // A claim may have persisted before an error. Refresh, never replay or discard it.
            const id = approved.proposal.id;
            reload();
            const index = inbox().findIndex((item) => item.id === id);
            if (index >= 0) selected = index;
          } finally {
            busy = false;
            if (expanded) await loadPreview();
            tui.requestRender();
          }
        }
        // Editor save reopens expanded, but the previous custom component no longer owns input.
        if (expanded && !preview && !loading) void loadPreview();

        const component = {
          render(width: number): string[] {
            lastWidth = width;
            const height = Math.max(1, tui.terminal.rows - 2);
            const inner = Math.max(1, width - 2);
            const bodyWidth = Math.max(1, inner - 1);
            const wrap = (text: string) => wrapTextWithAnsi(text, inner);
            const queue = inbox();
            const proposal = queue[selected];
            const summary = (item: Proposal, focused: boolean) => {
              const change = (item.draft ?? item).change;
              const effect =
                change.operation === 'complete'
                  ? 'complete task'
                  : change.operation === 'add'
                    ? 'add task'
                    : `replace ${
                        Object.entries(change.fields)
                          .map(([field, value]) => `${field}=${exact(value)}`)
                          .join(', ') || 'no fields'
                      }`;
              return [
                truncateToWidth(`${focused ? '>' : ' '} ${exact(title(item))}`, inner),
                truncateToWidth(
                  `  ${exact(project(item))} · ${exact(item.state)} · proposed ${effect}; ${change.annotations.length} annotation(s)`,
                  inner,
                ),
              ];
            };
            const header = wrap(
              `Task proposals · ${view === 'inbox' ? 'Inbox' : view === 'source' ? 'Source' : view === 'history' ? 'History' : 'History inspection'} · ${queue.length} Inbox · ${proposals.filter(decided).length} decided`,
            );
            if (view === 'inbox' && expanded && proposal) header.push(...summary(proposal, true));
            let controls: string;
            if (view === 'history')
              controls =
                '↑/↓ Select · Enter Inspect · PgUp/PgDn Scroll · Esc Back\nRead-only. No task writes.';
            else if (view === 'source' || view === 'inspection')
              controls = 'PgUp/PgDn Scroll · Esc Back\nRead-only. No task writes.';
            else {
              controls = queue.length
                ? `↑/↓ Focus · Enter ${expanded ? 'Collapse' : 'Expand'} · PgUp/PgDn Scroll\nCtrl+A ${!expanded ? 'Review' : loading ? 'Loading review' : !preview ? 'Preview unavailable' : ['applying', 'uncertain'].includes(preview.proposal.state) ? 'Verify only (no replay)' : 'Apply'}`
                : 'Inbox empty.';
              if (proposal?.state === 'pending') controls += ' · e Edit · d Dismiss';
              if (proposal) controls += ' · s Source';
              controls += ` · h History · Esc ${expanded ? 'Back' : 'Close'}\nEnter never applies.`;
            }
            const footer = wrap(controls);
            const feedback = message ? wrap(`Feedback: ${exact(message)}`) : [];
            const fixedFeedback =
              feedback.length > 3
                ? [...feedback.slice(0, 2), ...wrap('Full feedback is in the body.')]
                : feedback;
            let body: string[] = [];
            let focusLine = 0;
            if (view === 'source')
              body = wrapTextWithAnsi(sourceBody || 'No saved sources.', bodyWidth);
            else if (view === 'inspection') {
              const saved = historyEntries[historySelected]?.proposal;
              body = wrapTextWithAnsi(
                saved
                  ? `Saved snapshot and result (read-only):\n${exact(
                      {
                        id: saved.id,
                        revision: saved.revision,
                        state: saved.state,
                        change: saved.change,
                        expected: saved.expected,
                        question: saved.question,
                        draft: saved.draft,
                        explanation: saved.explanation,
                        sources: saved.sources,
                        result: saved.result,
                      },
                      2,
                    )}`
                  : 'No saved snapshot.',
                bodyWidth,
              );
            } else if (view === 'history') {
              for (const section of ['Selected-proposal revisions', 'Decided proposals']) {
                body.push(...wrapTextWithAnsi(section, bodyWidth));
                const entries = historyEntries.filter((entry) => entry.section === section);
                if (!entries.length) body.push('(none)');
                for (const entry of entries) {
                  const index = historyEntries.indexOf(entry);
                  if (index === historySelected) focusLine = body.length;
                  body.push(
                    ...wrapTextWithAnsi(
                      `${index === historySelected ? '>' : ' '} revision ${entry.proposal.revision} · ${exact(entry.proposal.state)} · ${exact(title(entry.proposal))}`,
                      bodyWidth,
                    ),
                  );
                }
              }
            } else if (expanded && proposal) {
              body = wrapTextWithAnsi(
                preview
                  ? previewText(preview)
                  : `${loading ? 'Loading current target…' : `Preview unavailable: ${exact(previewError)}`}\n${savedReviewText(proposal)}\nSaved proposed change (not verified): ${exact((proposal.draft ?? proposal).change, 2)}\nSaved unresolved question: ${exact((proposal.draft ?? proposal).question)}`,
                bodyWidth,
              );
            } else {
              body = queue.length
                ? queue.flatMap((item, index) => summary(item, index === selected))
                : ['No proposals in Inbox. History remains available.'];
              focusLine = selected * 2;
            }
            if (feedback.length > 3) {
              const fullFeedback = wrapTextWithAnsi(`Full feedback: ${exact(message)}`, bodyWidth);
              body.push('', ...fullFeedback);
            }
            // Keep collapsed summaries whole at both paging endpoints.
            if (view === 'inbox' && !expanded && body.length % 2) body.push('');
            // Reserve the longest range cue before allocating the single local viewport.
            const cueRows = wrap(
              `Rows ${body.length}-${body.length}/${body.length} · above · more below`,
            ).length;
            pageSize = Math.max(
              1,
              height - 2 - header.length - fixedFeedback.length - footer.length - cueRows,
            );
            viable =
              width >= 28 &&
              height >= 12 &&
              pageSize >= 4 &&
              2 + header.length + fixedFeedback.length + footer.length + cueRows + 4 <= height;
            if (!viable) {
              return wrapTextWithAnsi(
                'Resize terminal to review safely. Application blocked. Esc back/close.',
                Math.max(1, width),
              ).slice(0, height);
            }
            if (view === 'inbox' && !expanded) pageSize = Math.max(2, pageSize - (pageSize % 2));
            const maxOffset = Math.max(0, body.length - pageSize);
            let offset = Math.max(0, Math.min(offsets[view], maxOffset));
            if (reveal && ((view === 'inbox' && !expanded) || view === 'history')) {
              const focusEnd = focusLine + (view === 'inbox' ? 2 : 1);
              if (focusLine < offset) offset = focusLine;
              else if (focusEnd > offset + pageSize) offset = focusEnd - pageSize;
              offset = Math.max(0, Math.min(offset, maxOffset));
            }
            reveal = false;
            offsets[view] = offset;
            const thumbSize = Math.max(
              1,
              Math.floor(pageSize * Math.min(1, pageSize / Math.max(1, body.length))),
            );
            const thumbStart = maxOffset
              ? Math.round((offset / maxOffset) * (pageSize - thumbSize))
              : 0;
            const rows = Array.from({ length: pageSize }, (_, index) => {
              const line = sliceByColumn(body[offset + index] ?? '', 0, bodyWidth, true);
              const track = index >= thumbStart && index < thumbStart + thumbSize ? '█' : '│';
              return (
                line +
                ' '.repeat(Math.max(0, bodyWidth - visibleWidth(line))) +
                theme.fg('dim', track)
              );
            });
            const cue = wrap(
              `Rows ${body.length ? offset + 1 : 0}-${Math.min(offset + pageSize, body.length)}/${body.length} · ${offset ? 'above · ' : ''}${offset < maxOffset ? 'more below' : 'end'}`,
            );
            while (cue.length < cueRows) cue.push('');
            const row = (line: string) => {
              const clipped = sliceByColumn(line, 0, inner, true);
              return (
                theme.fg('border', '│') +
                clipped +
                ' '.repeat(Math.max(0, inner - visibleWidth(clipped))) +
                theme.fg('border', '│')
              );
            };
            return [
              theme.fg('border', `╭${'─'.repeat(inner)}╮`),
              ...header.map((line) => row(theme.fg('accent', line))),
              ...fixedFeedback.map((line) => row(theme.fg('muted', line))),
              ...rows.map(row),
              ...cue.map((line) => row(theme.fg('dim', line))),
              ...footer.map((line) => row(theme.fg('dim', line))),
              theme.fg('border', `╰${'─'.repeat(inner)}╯`),
            ];
          },
          invalidate() {},
          dispose() {
            active = false;
            request++;
            loading = false;
          },
          handleInput(data: string) {
            if (!active || busy) return;
            const queue = inbox();
            const proposal = queue[selected];
            if (kb.matches(data, 'tui.select.cancel')) {
              if (view === 'inspection') view = 'history';
              else if (view !== 'inbox') view = 'inbox';
              else if (expanded) {
                collapse();
                reveal = true;
              } else {
                active = false;
                request++;
                done('close');
                return;
              }
            } else {
              // Re-budget even if input arrives between a terminal resize and its next paint.
              component.render(Math.max(1, Math.min(lastWidth, tui.terminal.columns - 2)));
              if (!viable) return;
              if (matchesKey(data, 'pageDown')) offsets[view] += pageSize;
              else if (matchesKey(data, 'pageUp')) offsets[view] -= pageSize;
              else if (kb.matches(data, 'tui.select.up') || kb.matches(data, 'tui.select.down')) {
                const direction = kb.matches(data, 'tui.select.up') ? -1 : 1;
                if (view === 'inbox') {
                  const next = Math.max(0, Math.min(queue.length - 1, selected + direction));
                  if (queue.length && next !== selected) {
                    selected = next;
                    collapse();
                    reveal = true;
                  }
                } else if (view === 'history') {
                  historySelected = Math.max(
                    0,
                    Math.min(historyEntries.length - 1, historySelected + direction),
                  );
                  reveal = true;
                }
              } else if (kb.matches(data, 'tui.select.confirm')) {
                if (view === 'history' && historyEntries.length) {
                  view = 'inspection';
                  offsets.inspection = 0;
                } else if (view === 'inbox' && proposal) {
                  if (expanded) {
                    collapse();
                    reveal = true;
                  } else expand();
                }
              } else if (view === 'inbox') {
                if (matchesKey(data, 'ctrl+a') && proposal) {
                  if (!expanded) expand();
                  else if (preview && !loading) void authorize();
                } else if (data === 's' && proposal) {
                  sourceBody = sourceText(proposal);
                  offsets.source = 0;
                  view = 'source';
                } else if (data === 'h') openHistory();
                else if (data === 'e' && proposal?.state === 'pending') {
                  active = false;
                  request++;
                  loading = false;
                  done('edit');
                  return;
                } else if (data === 'd' && proposal?.state === 'pending') {
                  try {
                    requireTui(ctx.mode);
                    outcome(store.dismissProposal(proposal.id, proposal.revision));
                  } catch (error) {
                    message = String(error);
                    reload();
                    const index = inbox().findIndex((item) => item.id === proposal.id);
                    if (index >= 0) selected = index;
                    if (expanded) void loadPreview();
                  }
                }
              }
            }
            tui.requestRender();
          },
        };
        return component;
      },
      { overlay: true, overlayOptions: { width: '100%', maxHeight: '100%', margin: 1 } },
    );
    if (action !== 'edit') return;
    const proposal = inbox()[selected];
    if (!proposal || proposal.state !== 'pending') continue;
    try {
      requireTui(ctx.mode);
      const draft = proposal.draft ?? proposal;
      const text = await ctx.ui.editor(
        'Edit proposal JSON (save draft only; dates use YYYYMMDDTHHMMSSZ)',
        exact({ change: draft.change, expected: draft.expected, question: draft.question }, 2),
      );
      if (text !== undefined) {
        requireTui(ctx.mode);
        const edited = JSON.parse(text) as ProposalDraft;
        validateDraft(edited);
        const saved = store.editProposal(proposal.id, proposal.revision, edited);
        reload();
        selected = Math.max(
          0,
          inbox().findIndex((item) => item.id === saved.id),
        );
        expanded = true;
        preview = undefined;
        previewError = '';
        offsets.inbox = 0;
        message = 'Draft saved. Review the refreshed values before applying.';
      }
    } catch (error) {
      message = String(error);
    }
  }
}

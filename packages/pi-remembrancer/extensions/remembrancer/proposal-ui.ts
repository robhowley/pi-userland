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
import { boundedEvidencePage, safePrefixLength } from './review-pages.js';
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
const SOURCE_QUOTE_UNITS = 2048;
// One saved reference and quote fragment, independent of the optional original transcript.
// Called only by deliberate Source navigation, never while rendering a preview.
export function sourceText(proposal: Proposal, index = 0, page = 0): string {
  const source = proposal.sources[index];
  if (!source) return 'No saved sources.';
  const start = safePrefixLength(source.quote, 0, Math.max(0, page * SOURCE_QUOTE_UNITS));
  const end = safePrefixLength(source.quote, 0, Math.max(0, (page + 1) * SOURCE_QUOTE_UNITS));
  const saved = `Evidence ${index + 1}/${proposal.sources.length} · quote units ${start}-${end}/${source.quote.length} (UTF-16)\n${exact(source.role)} ${exact(source.timestamp)} ${exact(source.locator)}\nSaved quote fragment (JSON, exact):\n${exact(source.quote.slice(start, end))}\nFile: ${exact(source.file)}\nSession: ${exact(source.sessionId)}\nBranch: ${exact(source.branchId)}\nEntry: ${exact(source.entryId)}\nEdit: ${exact(source.editId)}\nExcerpt offset: ${source.offset}`;
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
    const surrounding = branch
      .slice(Math.max(0, index - 2), index + 3)
      .filter((item) => item !== selected);
    const contextStart = safePrefixLength(
      selected.text,
      0,
      Math.max(0, source.offset + start - 256),
    );
    const contextEnd = safePrefixLength(selected.text, 0, source.offset + end + 256);
    const page = boundedEvidencePage(surrounding, { index: 0, offset: 0 }, (entries) => ({
      selected: {
        ...selected,
        text: selected.text.slice(contextStart, contextEnd),
        offset: contextStart,
        continues: contextEnd < selected.text.length,
      },
      entries,
    }));
    return `${saved}\n\nLocal context (selected message window and up to two messages before and after, saved branch):\n${exact(page.data)}${page.cursor.index < surrounding.length ? '\nAdditional context omitted at the display limit.' : ''}`;
  } catch {
    return `${saved}\n\nExtra file context is unavailable: source missing, unreadable, over limits, or saved reference no longer matches.`;
  }
}
function savedReviewText(proposal: Proposal): string {
  const quote = proposal.sources[0]?.quote;
  const end = quote === undefined ? 0 : safePrefixLength(quote, 0, 240);
  return [
    `Saved title (not live verification): ${exact(title(proposal))}`,
    `Why: ${exact(proposal.explanation)}`,
    `Evidence: ${proposal.sources.length} saved reference(s). Press s for full saved quotes.`,
    ...(quote === undefined
      ? []
      : [
          `Supporting quote${end < quote.length ? ' (shortened)' : ''}: ${exact(quote.slice(0, end))}${end < quote.length ? '…' : ''}`,
        ]),
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
    lines.push('Edited draft. Press i to inspect the saved proposal and current draft.');
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
  let sourceIndex = 0;
  let sourcePage = 0;
  let historySelected = 0;
  let historyEntries: Proposal[] = [];
  let inspectionProposal: Proposal | undefined;
  let inspectionReturn: 'inbox' | 'history' = 'inbox';

  function reload(refreshed?: Proposal) {
    const id = inbox()[selected]?.id;
    if (refreshed) proposals[proposals.findIndex((item) => item.id === refreshed.id)] = refreshed;
    else {
      proposals = [];
      for (let offset = 0; ; offset += 50) {
        const page = store.proposals(undefined, offset, 50);
        proposals.push(...page);
        if (page.length < 50) break;
      }
    }
    proposals.sort(
      (a, b) =>
        project(a).localeCompare(project(b)) ||
        a.createdAt.localeCompare(b.createdAt) ||
        a.id.localeCompare(b.id),
    );
    const index = inbox().findIndex((item) => item.id === id);
    if (index >= 0) selected = index;
    else {
      selected = Math.max(0, Math.min(selected, inbox().length - 1));
      collapse();
    }
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
        let lastColumns = 0;
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
            reload(loaded.proposal);
            if (!expanded) {
              reveal = true;
              tui.requestRender();
            } else preview = loaded;
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
          historyEntries = proposals.filter(decided);
          historySelected = 0;
          offsets.history = 0;
          view = 'history';
          reveal = true;
        }
        function showSource() {
          const proposal = inbox()[selected];
          if (!proposal) return;
          sourceBody = sourceText(proposal, sourceIndex, sourcePage);
          offsets.source = 0;
          view = 'source';
        }
        function moveSource(direction: number, referenceOnly: boolean) {
          const proposal = inbox()[selected];
          const source = proposal?.sources[sourceIndex];
          if (!proposal || !source) return;
          const lastPage = Math.max(0, Math.ceil(source.quote.length / SOURCE_QUOTE_UNITS) - 1);
          if (referenceOnly) {
            const next = Math.max(
              0,
              Math.min(proposal.sources.length - 1, sourceIndex + direction),
            );
            if (next === sourceIndex) return;
            sourceIndex = next;
            sourcePage = 0;
          } else if (sourcePage + direction >= 0 && sourcePage + direction <= lastPage)
            sourcePage += direction;
          else {
            const next = sourceIndex + direction;
            if (next < 0 || next >= proposal.sources.length) return;
            sourceIndex = next;
            const quote = proposal.sources[next]!.quote;
            sourcePage =
              direction > 0 ? 0 : Math.max(0, Math.ceil(quote.length / SOURCE_QUOTE_UNITS) - 1);
          }
          showSource();
        }
        function inspect(proposal: Proposal, back: 'inbox' | 'history') {
          inspectionProposal = proposal;
          inspectionReturn = back;
          offsets.inspection = 0;
          view = 'inspection';
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
          reload();
          if (!expanded) reveal = true;
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
            reload();
            if (!expanded) reveal = true;
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
            lastColumns = tui.terminal.columns;
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
              `Task proposals · ${view === 'inbox' ? 'Inbox' : view === 'source' ? 'Source' : view === 'history' ? 'History' : 'Proposal inspection'} · ${queue.length} Inbox · ${proposals.filter(decided).length} decided`,
            );
            if (view === 'inbox' && expanded && proposal) header.push(...summary(proposal, true));
            if (view === 'source' && proposal?.sources[sourceIndex])
              header.push(
                ...wrap(
                  `Evidence ${sourceIndex + 1}/${proposal.sources.length} · quote page ${sourcePage + 1}/${Math.max(1, Math.ceil(proposal.sources[sourceIndex]!.quote.length / SOURCE_QUOTE_UNITS))}`,
                ),
              );
            let controls: string;
            if (view === 'history')
              controls =
                '↑/↓ Select · Enter Inspect · PgUp/PgDn Scroll · Esc Back\nRead-only. No task writes.';
            else if (view === 'source')
              controls =
                '←/→ Quote page · ↑/↓ Reference · PgUp/PgDn Scroll · Esc Back\nRead-only. No task writes.';
            else if (view === 'inspection')
              controls = 'PgUp/PgDn Scroll · Esc Back\nRead-only. No task writes.';
            else {
              controls = queue.length
                ? `↑/↓ Focus · Enter ${expanded ? 'Collapse' : 'Expand'} · PgUp/PgDn Scroll\nCtrl+A ${!expanded ? 'Review' : loading ? 'Loading review' : !preview ? 'Preview unavailable' : ['applying', 'uncertain'].includes(preview.proposal.state) ? 'Verify only (no replay)' : 'Apply'}`
                : 'Inbox empty.';
              if (proposal?.state === 'pending') controls += ' · e Edit · d Dismiss';
              if (proposal) controls += ' · s Source · i Inspect';
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
              const saved = inspectionProposal;
              body = wrapTextWithAnsi(
                saved
                  ? `Saved proposal and current draft (read-only):\n${exact(
                      {
                        id: saved.id,
                        revision: saved.revision,
                        state: saved.state,
                        change: saved.change,
                        expected: saved.expected,
                        question: saved.question,
                        draft: saved.draft,
                        explanation: saved.explanation,
                        result: saved.result,
                      },
                      2,
                    )}\nEvidence: ${saved.sources.length} saved reference(s).`
                  : 'No saved proposal.',
                bodyWidth,
              );
            } else if (view === 'history') {
              body.push('Decided proposals');
              if (!historyEntries.length) body.push('(none)');
              for (const [index, entry] of historyEntries.entries()) {
                if (index === historySelected) focusLine = body.length;
                body.push(
                  truncateToWidth(
                    `${index === historySelected ? '>' : ' '} revision ${entry.revision} · ${exact(entry.state)} · ${exact(title(entry))}`,
                    bodyWidth,
                  ),
                );
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
              if (view === 'inspection') view = inspectionReturn;
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
              // Let Pi resolve the overlay width after a resize, then re-budget for this input.
              if (lastColumns !== tui.terminal.columns) tui.renderNow();
              component.render(lastWidth);
              if (!viable) return;
              if (matchesKey(data, 'pageDown')) offsets[view] += pageSize;
              else if (matchesKey(data, 'pageUp')) offsets[view] -= pageSize;
              else if (view === 'source' && (matchesKey(data, 'left') || matchesKey(data, 'right')))
                moveSource(matchesKey(data, 'left') ? -1 : 1, false);
              else if (kb.matches(data, 'tui.select.up') || kb.matches(data, 'tui.select.down')) {
                const direction = kb.matches(data, 'tui.select.up') ? -1 : 1;
                if (view === 'inbox') {
                  const next = Math.max(0, Math.min(queue.length - 1, selected + direction));
                  if (queue.length && next !== selected) {
                    selected = next;
                    collapse();
                    reveal = true;
                  }
                } else if (view === 'source') moveSource(direction, true);
                else if (view === 'history') {
                  historySelected = Math.max(
                    0,
                    Math.min(historyEntries.length - 1, historySelected + direction),
                  );
                  reveal = true;
                }
              } else if (kb.matches(data, 'tui.select.confirm')) {
                if (view === 'history' && historyEntries.length) {
                  inspect(historyEntries[historySelected]!, 'history');
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
                  sourceIndex = 0;
                  sourcePage = 0;
                  showSource();
                } else if (data === 'i' && proposal) inspect(proposal, 'inbox');
                else if (data === 'h') openHistory();
                else if (data === 'e' && proposal?.state === 'pending') {
                  active = false;
                  request++;
                  loading = false;
                  done('edit');
                  return;
                } else if (data === 'd' && proposal?.state === 'pending') {
                  const focusLine = selected * 2;
                  if (
                    !expanded &&
                    (focusLine < offsets.inbox || focusLine + 2 > offsets.inbox + pageSize)
                  ) {
                    reveal = true;
                    tui.requestRender();
                    return;
                  }
                  try {
                    requireTui(ctx.mode);
                    outcome(store.dismissProposal(proposal.id, proposal.revision));
                  } catch (error) {
                    message = String(error);
                    reload();
                    if (expanded) void loadPreview();
                    else reveal = true;
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
      reload();
      preview = undefined;
      previewError = '';
    }
  }
}

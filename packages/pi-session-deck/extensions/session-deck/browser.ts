import type { Theme } from '@earendil-works/pi-coding-agent';
import { matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from '@mariozechner/pi-tui';
import {
  formatSessionDeckBrowserCardLines,
  formatSessionDeckBrowserRow,
  formatSessionDeckDiagnosticLine,
  getSessionDeckBrowserTitle,
  getSessionDeckEmptyMessage,
  shouldDimSessionDeckBrowserRow,
} from './browser-render.js';
import type { SessionDeckBrowserRow } from './browser-render.js';
import type { SessionDeckBrowserRecord, SessionDeckBrowserSnapshot } from './browser-view.js';
import {
  getPiDefaultAgentDirDisplay,
  normalizeLaunchAgentDirSelection,
  shortenHomeDir,
} from './worktree/agent-dir.js';
import type {
  CreateWorktreeActionRequest,
  CreateWorktreeActionResult,
  CreateWorktreeLaunchAgentDir,
  CreateWorktreeLaunchAgentDirMode,
  CreateWorktreeStatusUpdate,
  WorktreeLaunchContextPreviewResult,
} from './worktree/types.js';

const DEFAULT_MAX_VISIBLE_ROWS = 8;
const DEFAULT_MAX_VISIBLE_REPOS = 4;
const AUTO_REFRESH_INTERVAL_MS = 15_000;
const ALL_REPO_FILTER_KEY = Symbol('all-repo-filter');
const NO_REPO_FILTER_KEY = Symbol('no-repo-filter');

type SessionDeckRefreshMode = 'manual' | 'auto';
type SessionDeckRepoKey = string | typeof ALL_REPO_FILTER_KEY | typeof NO_REPO_FILTER_KEY;
type SessionDeckNamedRepoFilter = {
  kind: 'named';
  key: string;
  shortLabel: string;
  qualifiedLabel: string | null;
};
type SessionDeckRepoFilter = { kind: 'all' } | { kind: 'no-repo' } | SessionDeckNamedRepoFilter;

interface SessionDeckRepoOption {
  key: SessionDeckRepoKey;
  label: string;
  filter: SessionDeckRepoFilter;
}

interface SessionDeckRepoState {
  options: SessionDeckRepoOption[];
  recordsByKey: Map<SessionDeckRepoKey, SessionDeckBrowserRecord[]>;
}

interface SessionDeckNamedRepoBucket {
  key: string;
  shortLabel: string;
  qualifiedLabel: string | null;
  records: SessionDeckBrowserRecord[];
}

interface SessionDeckPendingRepoGroup {
  shortLabel: string;
  qualifiedLabels: Set<string>;
  records: SessionDeckBrowserRecord[];
}

interface SessionDeckBrowserSelection {
  repoState: SessionDeckRepoState;
  repoIndex: number;
  repoOption: SessionDeckRepoOption;
  records: SessionDeckBrowserRecord[];
}

export interface SessionDeckBrowserOpenSelectedResult {
  ok: boolean;
  message: string;
}

export type SessionDeckBrowserOpenSelected = (
  record: SessionDeckBrowserRecord,
) => Promise<SessionDeckBrowserOpenSelectedResult>;

export interface SessionDeckBrowserKillSelectedResult {
  ok: boolean;
  message: string;
}

export type SessionDeckBrowserKillSelected = (
  record: SessionDeckBrowserRecord,
) => Promise<SessionDeckBrowserKillSelectedResult>;

export type SessionDeckBrowserCreateWorktree = (
  request: CreateWorktreeActionRequest,
  onStatus: (update: CreateWorktreeStatusUpdate) => void,
) => Promise<CreateWorktreeActionResult>;

export type SessionDeckBrowserPreviewLaunchContext = (
  agentDir: CreateWorktreeLaunchAgentDir,
) => Promise<WorktreeLaunchContextPreviewResult>;

type SessionDeckWorktreePromptFocus = 'branch' | 'pi-config';

interface SessionDeckWorktreePrompt {
  branchName: string;
  agentDirSelection: CreateWorktreeLaunchAgentDir;
  customDraft: string;
  focus: SessionDeckWorktreePromptFocus;
  selectorOpen: boolean;
  selectorIndex: number;
  feedback: string | null;
  launchContext: WorktreeLaunchContextPreviewResult | { status: 'loading' };
  launchContextRequestId: number;
}

interface SessionDeckKillConfirm {
  runtimeId: string;
  title: string;
  shortRuntimeId: string;
  pid: number | null;
}

export interface SessionDeckBrowserOptions {
  all: boolean;
  showIdentity: boolean;
  initialView: SessionDeckBrowserSnapshot;
  onClose: () => void;
  openSelected?: SessionDeckBrowserOpenSelected;
  killSelected?: SessionDeckBrowserKillSelected;
  createWorktree?: SessionDeckBrowserCreateWorktree;
  previewLaunchContext?: SessionDeckBrowserPreviewLaunchContext;
  reload: () => Promise<SessionDeckBrowserSnapshot>;
  requestRender: () => void;
  reapLines?: string[];
  theme: Theme;
}

export class SessionDeckBrowser {
  private readonly all: boolean;
  private readonly showIdentity: boolean;
  private readonly onClose: () => void;
  private readonly openSelected: SessionDeckBrowserOpenSelected | null;
  private readonly killSelected: SessionDeckBrowserKillSelected | null;
  private readonly createWorktree: SessionDeckBrowserCreateWorktree | null;
  private readonly previewLaunchContext: SessionDeckBrowserPreviewLaunchContext;
  private readonly reload: () => Promise<SessionDeckBrowserSnapshot>;
  private readonly requestRender: () => void;
  private readonly reapLines: string[];
  private readonly theme: Theme;

  private view: SessionDeckBrowserSnapshot;
  private selectedRepoKey: SessionDeckRepoKey = ALL_REPO_FILTER_KEY;
  private selectedIndex = 0;
  private detailVisible = true;
  private refreshStatus: { message: string; tone: 'muted' | 'warning' } | null = null;
  private openStatus: { message: string; tone: 'muted' | 'warning' } | null = null;
  private killStatus: { message: string; tone: 'muted' | 'warning' } | null = null;
  private worktreeStatus: { message: string; tone: 'muted' | 'warning' } | null = null;
  private worktreePrompt: SessionDeckWorktreePrompt | null = null;
  private killConfirm: SessionDeckKillConfirm | null = null;
  private refreshPending: Promise<void> | null = null;
  private openPending: Promise<void> | null = null;
  private killPending: Promise<void> | null = null;
  private worktreePending: Promise<void> | null = null;
  private isRefreshing = false;
  private autoRefreshInterval: ReturnType<typeof setInterval> | null = null;
  private disposed = false;
  private cachedWidth: number | undefined;
  private cachedLines: string[] | undefined;

  constructor(options: SessionDeckBrowserOptions) {
    this.all = options.all;
    this.showIdentity = options.showIdentity;
    this.onClose = options.onClose;
    this.openSelected = options.openSelected ?? null;
    this.killSelected = options.killSelected ?? null;
    this.createWorktree = options.createWorktree ?? null;
    this.previewLaunchContext = options.previewLaunchContext ?? previewLaunchContextFromProcess;
    this.reload = options.reload;
    this.requestRender = options.requestRender;
    this.reapLines = options.reapLines ?? [];
    this.theme = options.theme;
    this.view = options.initialView;
    this.selectedIndex = clampIndex(0, this.view.records.length);
    this.startAutoRefresh();
  }

  handleInput(data: string): void {
    if (this.disposed) {
      return;
    }

    if (this.worktreePrompt !== null) {
      this.handleWorktreePromptInput(data);
      return;
    }

    if (this.killConfirm !== null) {
      this.handleKillConfirmInput(data);
      return;
    }

    if (matchesKey(data, 'escape') || matchesKey(data, 'ctrl+c') || data === 'q') {
      this.dispose();
      this.onClose();
      return;
    }

    if (matchesKey(data, 'enter') || matchesKey(data, 'return')) {
      this.detailVisible = !this.detailVisible;
      this.clearStatus();
      this.bump();
      return;
    }

    if (matchesKey(data, 'r')) {
      void this.refresh();
      return;
    }

    const selection = this.getSelection();

    if (matchesKey(data, 'w')) {
      this.openWorktreePrompt(selection);
      return;
    }

    if (this.view.records.length === 0) {
      return;
    }

    const selectedRecord = selection.records[this.selectedIndex] ?? null;

    if (matchesKey(data, 'k')) {
      if (selectedRecord !== null) {
        this.openKillConfirmation(selectedRecord);
      }
      return;
    }

    if (matchesKey(data, 'o')) {
      if (selectedRecord !== null) {
        void this.openSelectedRecord(selectedRecord);
      }
      return;
    }

    if (matchesKey(data, 'left')) {
      this.switchRepo(-1, selection);
      return;
    }

    if (matchesKey(data, 'right')) {
      this.switchRepo(1, selection);
      return;
    }

    if (matchesKey(data, 'up')) {
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
      this.clearStatus();
      this.bump();
      return;
    }

    if (matchesKey(data, 'down')) {
      this.selectedIndex = Math.min(selection.records.length - 1, this.selectedIndex + 1);
      this.clearStatus();
      this.bump();
    }
  }

  render(width: number): string[] {
    if (this.cachedLines !== undefined && this.cachedWidth === width) {
      return this.cachedLines;
    }

    const selection = this.getSelection();
    const lines: string[] = [];
    const title = this.theme.fg(
      'accent',
      this.theme.bold(getSessionDeckBrowserTitle(this.view, this.all)),
    );
    const help = this.theme.fg(
      'muted',
      '↑↓ move · ←→ switch repo · enter details · w new Pi session · o open terminal · k stop Pi · r refresh · q close',
    );

    pushWrappedLine(lines, title, width);
    pushWrappedLine(lines, help, width);

    if (this.isRefreshing) {
      pushWrappedLine(lines, this.theme.fg('muted', 'Refreshing session deck…'), width);
    } else if (this.refreshStatus !== null) {
      pushWrappedLine(
        lines,
        this.theme.fg(this.refreshStatus.tone, this.refreshStatus.message),
        width,
      );
    }

    if (this.openStatus !== null) {
      pushWrappedLine(lines, this.theme.fg(this.openStatus.tone, this.openStatus.message), width);
    }

    if (this.killStatus !== null) {
      pushWrappedLine(lines, this.theme.fg(this.killStatus.tone, this.killStatus.message), width);
    }

    if (this.worktreeStatus !== null) {
      pushWrappedLine(
        lines,
        this.theme.fg(this.worktreeStatus.tone, this.worktreeStatus.message),
        width,
      );
    }

    if (this.worktreePrompt !== null) {
      for (const line of this.formatWorktreePromptLines()) {
        pushWrappedLine(lines, this.theme.fg('accent', line), width);
      }
    }

    if (this.killConfirm !== null) {
      pushWrappedLine(lines, this.theme.fg('warning', this.formatKillConfirmation()), width);
    }

    if (this.reapLines.length > 0) {
      lines.push('');
      for (const line of this.reapLines) {
        pushWrappedLine(lines, this.theme.fg('muted', line), width);
      }
    }

    if (this.view.records.length === 0) {
      lines.push('');
      pushWrappedLine(lines, getSessionDeckEmptyMessage(this.all), width);
    } else {
      lines.push(
        renderRepoRow(this.theme, selection.repoState.options, selection.repoIndex, width),
      );
      lines.push('');

      const windowed = getVisibleWindow(
        selection.records.length,
        DEFAULT_MAX_VISIBLE_ROWS,
        this.selectedIndex,
      );

      for (let index = windowed.start; index < windowed.end; index += 1) {
        const record = selection.records[index]!;
        const row = formatSessionDeckBrowserRow(record);
        const isSelected = index === this.selectedIndex;

        lines.push(renderRowLine1(this.theme, record, row, isSelected, width));
        lines.push(renderRowLine2(this.theme, record, row, isSelected, width));

        if (index < windowed.end - 1) {
          lines.push('');
        }
      }

      if (windowed.end - windowed.start < selection.records.length) {
        pushWrappedLine(
          lines,
          this.theme.fg(
            'dim',
            `Showing ${windowed.start + 1}-${windowed.end} of ${selection.records.length}`,
          ),
          width,
        );
      }
    }

    lines.push('');

    if (!this.detailVisible) {
      pushWrappedLine(lines, this.theme.fg('dim', 'Details hidden · Enter to show.'), width);
    } else {
      const selected = selection.records[this.selectedIndex] ?? null;
      if (selected === null) {
        pushWrappedLine(lines, this.theme.fg('dim', 'No selected session.'), width);
      } else {
        const cardLines = formatSessionDeckBrowserCardLines(selected, {
          all: this.all,
          showIdentity: this.showIdentity,
        });
        if (cardLines.length > 0) {
          cardLines[0] = this.theme.fg('accent', this.theme.bold(cardLines[0]!));
        }
        pushBoxedLines(lines, cardLines, width);
      }
    }

    if (this.all && this.view.diagnostics.length > 0) {
      lines.push('');
      pushWrappedLine(lines, this.theme.fg('muted', this.theme.bold('Diagnostics')), width);
      for (const diagnostic of this.view.diagnostics) {
        pushWrappedLine(lines, formatSessionDeckDiagnosticLine(diagnostic), width, '  ');
      }
    }

    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }

  dispose(): void {
    this.disposed = true;
    if (this.autoRefreshInterval !== null) {
      clearInterval(this.autoRefreshInterval);
      this.autoRefreshInterval = null;
    }
  }

  private openWorktreePrompt(selection: SessionDeckBrowserSelection): void {
    if (this.worktreePending !== null) {
      this.worktreeStatus = { message: 'Already starting a new Pi session…', tone: 'muted' };
      this.bump();
      return;
    }

    if (this.createWorktree === null) {
      this.worktreeStatus = {
        message: 'New Pi session action is unavailable in this context.',
        tone: 'warning',
      };
      this.bump();
      return;
    }

    if (selection.repoOption.filter.kind !== 'named') {
      this.worktreeStatus = {
        message: 'Switch to a named repo filter before starting a new Pi session.',
        tone: 'warning',
      };
      this.bump();
      return;
    }

    this.clearStatus();
    this.worktreePrompt = createInitialWorktreePrompt();
    this.refreshWorktreeLaunchContextPreview(this.worktreePrompt);
    this.bump();
  }

  private handleWorktreePromptInput(data: string): void {
    const prompt = this.worktreePrompt;
    if (prompt === null) {
      return;
    }

    if (matchesKey(data, 'escape') || matchesKey(data, 'ctrl+c')) {
      if (prompt.selectorOpen) {
        prompt.selectorOpen = false;
        prompt.feedback = null;
        this.bump();
        return;
      }
      this.worktreePrompt = null;
      this.worktreeStatus = { message: 'New Pi session cancelled.', tone: 'muted' };
      this.bump();
      return;
    }

    if (prompt.selectorOpen) {
      this.handleWorktreePromptSelectorInput(prompt, data);
      return;
    }

    if (isTabKey(data)) {
      prompt.focus = prompt.focus === 'branch' ? 'pi-config' : 'branch';
      prompt.feedback = null;
      this.bump();
      return;
    }

    if (isShiftTabKey(data)) {
      prompt.focus = prompt.focus === 'branch' ? 'pi-config' : 'branch';
      prompt.feedback = null;
      this.bump();
      return;
    }

    if (matchesKey(data, 'enter') || matchesKey(data, 'return')) {
      if (prompt.focus === 'pi-config') {
        prompt.selectorOpen = true;
        prompt.selectorIndex = agentDirModeIndex(prompt.agentDirSelection.mode);
        prompt.feedback = null;
        this.bump();
        return;
      }
      void this.submitWorktreePrompt(prompt);
      return;
    }

    if (prompt.focus !== 'branch') {
      return;
    }

    if (matchesKey(data, 'backspace') || data === '\u007f') {
      prompt.branchName = prompt.branchName.slice(0, -1);
      this.bump();
      return;
    }

    if (isPrintableInput(data)) {
      prompt.branchName += data;
      this.bump();
    }
  }

  private handleWorktreePromptSelectorInput(prompt: SessionDeckWorktreePrompt, data: string): void {
    if (matchesKey(data, 'up') || matchesKey(data, 'left')) {
      prompt.selectorIndex =
        (prompt.selectorIndex + AGENT_DIR_MODE_OPTIONS.length - 1) % AGENT_DIR_MODE_OPTIONS.length;
      prompt.feedback = null;
      this.bump();
      return;
    }
    if (matchesKey(data, 'down') || matchesKey(data, 'right') || isTabKey(data)) {
      prompt.selectorIndex = (prompt.selectorIndex + 1) % AGENT_DIR_MODE_OPTIONS.length;
      prompt.feedback = null;
      this.bump();
      return;
    }
    if (isShiftTabKey(data)) {
      prompt.selectorIndex =
        (prompt.selectorIndex + AGENT_DIR_MODE_OPTIONS.length - 1) % AGENT_DIR_MODE_OPTIONS.length;
      prompt.feedback = null;
      this.bump();
      return;
    }

    const selectedMode = AGENT_DIR_MODE_OPTIONS[prompt.selectorIndex] ?? 'ambient';
    if (selectedMode === 'custom') {
      if (matchesKey(data, 'backspace') || data === '\u007f') {
        prompt.customDraft = prompt.customDraft.slice(0, -1);
        prompt.feedback = null;
        this.bump();
        return;
      }
      if (isPrintableInput(data)) {
        prompt.customDraft += data;
        prompt.feedback = null;
        this.bump();
        return;
      }
    }

    const quickMode = getAgentDirQuickMode(data);
    if (quickMode !== null) {
      prompt.selectorIndex = agentDirModeIndex(quickMode);
      this.applyWorktreePromptAgentDirSelection(prompt);
      return;
    }

    if (matchesKey(data, 'enter') || matchesKey(data, 'return')) {
      this.applyWorktreePromptAgentDirSelection(prompt);
    }
  }

  private applyWorktreePromptAgentDirSelection(prompt: SessionDeckWorktreePrompt): void {
    const selectedMode = AGENT_DIR_MODE_OPTIONS[prompt.selectorIndex] ?? 'ambient';
    const candidate =
      selectedMode === 'custom'
        ? { mode: selectedMode, customDir: prompt.customDraft }
        : { mode: selectedMode };
    const normalized = normalizeLaunchAgentDirSelection(candidate);
    if (!normalized.ok) {
      prompt.feedback = normalized.message;
      this.bump();
      return;
    }

    prompt.agentDirSelection = normalized.agentDir;
    prompt.selectorOpen = false;
    prompt.focus = 'pi-config';
    prompt.feedback = null;
    this.refreshWorktreeLaunchContextPreview(prompt);
    this.bump();
  }

  private async submitWorktreePrompt(prompt: SessionDeckWorktreePrompt): Promise<void> {
    if (this.worktreePending !== null) {
      this.worktreeStatus = { message: 'Already starting a new Pi session…', tone: 'muted' };
      this.bump();
      return this.worktreePending;
    }

    const branchName = prompt.branchName.trim();
    if (branchName.length === 0) {
      this.worktreeStatus = { message: 'Enter a branch name.', tone: 'warning' };
      this.bump();
      return;
    }

    const selection = this.getSelection();
    if (selection.repoOption.filter.kind !== 'named' || this.createWorktree === null) {
      this.worktreePrompt = null;
      this.worktreeStatus = {
        message: 'New Pi session action is unavailable here.',
        tone: 'warning',
      };
      this.bump();
      return;
    }

    const normalizedAgentDir = normalizeLaunchAgentDirSelection(prompt.agentDirSelection);
    if (!normalizedAgentDir.ok) {
      this.worktreeStatus = { message: normalizedAgentDir.message, tone: 'warning' };
      this.bump();
      return;
    }

    const promptSnapshot = cloneWorktreePrompt(prompt);
    const fallbackSelectedRuntimeId = selection.records[this.selectedIndex]?.runtimeId ?? null;
    const request = buildWorktreeRequest(
      selection,
      this.selectedIndex,
      branchName,
      normalizedAgentDir.agentDir,
    );
    this.worktreePrompt = null;
    this.worktreeStatus = { message: 'Starting new Pi session…', tone: 'muted' };
    this.bump();

    this.worktreePending = (async () => {
      try {
        const result = await this.createWorktree!(request, (update) => {
          this.worktreeStatus = { message: update.message, tone: 'muted' };
          this.bump();
        });
        if (this.disposed) {
          return;
        }

        this.worktreeStatus = formatWorktreeResultStatus(result);
        if (!result.ok) {
          if (result.status === 'failed' || result.status === 'preflight-failed') {
            this.worktreePrompt = promptSnapshot;
          }
          return;
        }

        const selectedRuntimeId =
          result.launch.requested && result.launch.ok
            ? (result.launch.runtimeId ?? fallbackSelectedRuntimeId)
            : fallbackSelectedRuntimeId;
        await this.refreshAfterWorktree(selectedRuntimeId);
      } catch (error) {
        if (!this.disposed) {
          this.worktreePrompt = promptSnapshot;
          this.worktreeStatus = {
            message: `Starting new Pi session failed: ${getErrorMessage(error)}`,
            tone: 'warning',
          };
        }
      } finally {
        this.worktreePending = null;
        this.bump();
      }
    })();

    return this.worktreePending;
  }

  private formatWorktreePromptLines(): string[] {
    const prompt = this.worktreePrompt;
    if (prompt === null) {
      return [];
    }

    const selection = this.getSelection();
    const repoLabel = selection.repoOption.label;
    const branchName = prompt.branchName.length === 0 ? '<branch-name>' : prompt.branchName;
    const branchMarker = prompt.focus === 'branch' ? '› ' : '  ';
    const piConfigMarker = prompt.focus === 'pi-config' ? '› ' : '  ';
    const lines = [
      `New Pi session for ${repoLabel}`,
      `${branchMarker}Branch:    ${branchName}`,
      `${piConfigMarker}${formatWorktreePromptLaunchContext(prompt)}   Change`,
      '  Base:      default branch · generated worktree · detached tmux',
    ];

    if (prompt.selectorOpen) {
      lines.push(formatWorktreePromptSelector(prompt));
      if ((AGENT_DIR_MODE_OPTIONS[prompt.selectorIndex] ?? 'ambient') === 'custom') {
        lines.push(
          `  Custom:    ${prompt.customDraft.length === 0 ? '<absolute-or-~/dir>' : prompt.customDraft}`,
        );
      }
    }
    if (prompt.feedback !== null) {
      lines.push(`  ${prompt.feedback}`);
    }
    lines.push('  tab focus · enter create/change · esc cancel');
    return lines;
  }

  private refreshWorktreeLaunchContextPreview(prompt: SessionDeckWorktreePrompt): void {
    const requestId = prompt.launchContextRequestId + 1;
    prompt.launchContextRequestId = requestId;
    prompt.launchContext = { status: 'loading' };
    const selection = prompt.agentDirSelection;
    void this.previewLaunchContext(selection)
      .then((result) => {
        if (
          this.disposed ||
          this.worktreePrompt !== prompt ||
          prompt.launchContextRequestId !== requestId
        ) {
          return;
        }
        prompt.launchContext = result;
        this.bump();
      })
      .catch((error) => {
        if (
          this.disposed ||
          this.worktreePrompt !== prompt ||
          prompt.launchContextRequestId !== requestId
        ) {
          return;
        }
        prompt.launchContext = {
          ok: false,
          status: 'failed',
          reason: 'invalid-request',
          message: getErrorMessage(error),
          recoverable: true,
        };
        this.bump();
      });
  }

  private openKillConfirmation(record: SessionDeckBrowserRecord): void {
    if (this.killPending !== null) {
      this.killStatus = { message: 'Already requesting stop for a Pi session…', tone: 'muted' };
      this.bump();
      return;
    }

    if (this.killSelected === null) {
      this.killStatus = {
        message: 'Stop Pi is unavailable in this context.',
        tone: 'warning',
      };
      this.bump();
      return;
    }

    const row = formatSessionDeckBrowserRow(record);
    this.clearStatus();
    this.killConfirm = {
      runtimeId: record.runtimeId,
      title: row.title,
      shortRuntimeId: formatShortRuntimeId(record.runtimeId),
      pid: record.pid,
    };
    this.bump();
  }

  private handleKillConfirmInput(data: string): void {
    if (matchesKey(data, 'escape') || matchesKey(data, 'ctrl+c') || data === 'q') {
      this.killConfirm = null;
      this.killStatus = { message: 'Stop Pi cancelled.', tone: 'muted' };
      this.bump();
      return;
    }

    if (matchesKey(data, 'enter') || matchesKey(data, 'return')) {
      void this.submitKillConfirmation();
    }
  }

  private async submitKillConfirmation(): Promise<void> {
    const confirmation = this.killConfirm;
    const killSelected = this.killSelected;
    if (confirmation === null || killSelected === null) {
      return;
    }

    if (this.killPending !== null) {
      this.killStatus = { message: 'Already requesting stop for a Pi session…', tone: 'muted' };
      this.bump();
      return this.killPending;
    }

    const record = this.view.records.find(
      (candidate) => candidate.runtimeId === confirmation.runtimeId,
    );
    if (record === undefined) {
      this.killConfirm = null;
      this.killStatus = {
        message: 'Stop cancelled; selected session is no longer visible.',
        tone: 'muted',
      };
      this.bump();
      return;
    }

    this.killConfirm = null;
    this.killStatus = { message: 'Requesting Pi stop…', tone: 'muted' };
    this.bump();

    this.killPending = (async () => {
      try {
        const result = await killSelected(record);
        if (this.disposed) {
          return;
        }

        this.killStatus = {
          message: result.message,
          tone: result.ok ? 'muted' : 'warning',
        };
        void this.refresh('auto');
      } catch (error) {
        if (this.disposed) {
          return;
        }

        this.killStatus = {
          message: `Stop request failed: ${getErrorMessage(error)}`,
          tone: 'warning',
        };
      } finally {
        this.killPending = null;
        this.bump();
      }
    })();

    return this.killPending;
  }

  private formatKillConfirmation(): string {
    const confirmation = this.killConfirm;
    if (confirmation === null) {
      return '';
    }

    const pid = confirmation.pid === null ? 'pid unavailable' : `pid ${confirmation.pid}`;
    return `Stop Pi for ${confirmation.title} (${confirmation.shortRuntimeId}, ${pid})? Sends SIGTERM to the Pi runtime only. Session history is preserved. iTerm/tmux may exit naturally. Enter confirm · esc/q cancel`;
  }

  private async refreshAfterWorktree(runtimeId: string | null): Promise<void> {
    const nextView = await this.reload();
    if (this.disposed) {
      return;
    }
    this.applyNextView(nextView, runtimeId);
  }

  private async openSelectedRecord(record: SessionDeckBrowserRecord): Promise<void> {
    if (this.disposed) {
      return;
    }

    const openSelected = this.openSelected;
    if (openSelected === null) {
      this.openStatus = {
        message: 'Terminal open requests are unavailable in this context.',
        tone: 'warning',
      };
      this.bump();
      return;
    }

    if (this.openPending !== null) {
      this.openStatus = { message: 'Already opening terminal…', tone: 'muted' };
      this.bump();
      return this.openPending;
    }

    this.openStatus = { message: 'Opening terminal…', tone: 'muted' };
    this.bump();

    this.openPending = (async () => {
      try {
        const result = await openSelected(record);
        if (this.disposed) {
          return;
        }

        this.openStatus = {
          message: result.message,
          tone: result.ok ? 'muted' : 'warning',
        };
      } catch (error) {
        if (this.disposed) {
          return;
        }

        this.openStatus = {
          message: `Failed to open terminal: ${getErrorMessage(error)}`,
          tone: 'warning',
        };
      } finally {
        this.openPending = null;
        this.bump();
      }
    })();

    return this.openPending;
  }

  private async refresh(mode: SessionDeckRefreshMode = 'manual'): Promise<void> {
    if (this.disposed) {
      return;
    }

    if (mode === 'auto' && (this.worktreePrompt !== null || this.worktreePending !== null)) {
      return;
    }

    if (this.refreshPending !== null) {
      return this.refreshPending;
    }

    if (mode === 'manual') {
      this.isRefreshing = true;
      this.refreshStatus = null;
      this.bump();
    }

    this.refreshPending = (async () => {
      try {
        const nextView = await this.reload();
        if (this.disposed) {
          return;
        }

        const selection = this.getSelection();
        const selectedRuntimeId = selection.records[this.selectedIndex]?.runtimeId ?? null;
        this.applyNextView(nextView, selectedRuntimeId);
        this.refreshStatus = null;
      } catch (error) {
        if (this.disposed) {
          return;
        }

        this.refreshStatus =
          mode === 'manual'
            ? { message: `Refresh failed: ${getErrorMessage(error)}`, tone: 'warning' }
            : { message: `Auto refresh failed: ${getErrorMessage(error)}`, tone: 'muted' };
      } finally {
        this.isRefreshing = false;
        this.refreshPending = null;
        this.bump();
      }
    })();

    return this.refreshPending;
  }

  private applyNextView(
    nextView: SessionDeckBrowserSnapshot,
    selectedRuntimeId: string | null,
  ): void {
    const selection = this.getSelection();
    const nextRepoState = buildRepoState(nextView.records);
    const nextRepoOption = getPreservedRepoOption(nextRepoState, selection.repoOption.filter);

    this.view = nextView;
    this.selectedRepoKey = nextRepoOption.key;
    this.selectedIndex = findSelectedIndex(
      getRepoRecords(nextRepoState.recordsByKey, nextRepoOption.key),
      selectedRuntimeId,
    );

    if (
      this.killConfirm !== null &&
      !nextView.records.some((record) => record.runtimeId === this.killConfirm?.runtimeId)
    ) {
      this.killConfirm = null;
      this.killStatus = {
        message: 'Stop cancelled; selected session is no longer visible.',
        tone: 'muted',
      };
    }
  }

  private startAutoRefresh(): void {
    this.autoRefreshInterval = setInterval(() => {
      void this.refresh('auto');
    }, AUTO_REFRESH_INTERVAL_MS);
    this.autoRefreshInterval.unref?.();
  }

  private switchRepo(direction: -1 | 1, selection: SessionDeckBrowserSelection): void {
    const nextRepoIndex = clampIndex(
      selection.repoIndex + direction,
      selection.repoState.options.length,
    );
    if (nextRepoIndex === selection.repoIndex) {
      return;
    }

    const selectedRuntimeId = selection.records[this.selectedIndex]?.runtimeId ?? null;
    const nextRepoKey = selection.repoState.options[nextRepoIndex]?.key;
    if (nextRepoKey === undefined) {
      return;
    }

    this.selectedRepoKey = nextRepoKey;
    this.selectedIndex = findSelectedIndex(
      getRepoRecords(selection.repoState.recordsByKey, nextRepoKey),
      selectedRuntimeId,
    );
    this.clearStatus();
    this.bump();
  }

  private getSelection(): SessionDeckBrowserSelection {
    return getRepoSelection(buildRepoState(this.view.records), this.selectedRepoKey);
  }

  private clearStatus(): void {
    this.refreshStatus = null;
    this.openStatus = null;
    this.killStatus = null;
    this.worktreeStatus = null;
  }

  private bump(): void {
    if (this.disposed) {
      return;
    }

    this.invalidate();
    this.requestRender();
  }
}

const AGENT_DIR_MODE_OPTIONS: CreateWorktreeLaunchAgentDirMode[] = ['ambient', 'default', 'custom'];

function createInitialWorktreePrompt(): SessionDeckWorktreePrompt {
  return {
    branchName: '',
    agentDirSelection: { mode: 'ambient' },
    customDraft: '',
    focus: 'branch',
    selectorOpen: false,
    selectorIndex: 0,
    feedback: null,
    launchContext: { status: 'loading' },
    launchContextRequestId: 0,
  };
}

function cloneWorktreePrompt(prompt: SessionDeckWorktreePrompt): SessionDeckWorktreePrompt {
  return {
    ...prompt,
    agentDirSelection: { ...prompt.agentDirSelection },
    launchContext:
      prompt.launchContext.status === 'loading'
        ? { status: 'loading' }
        : { ...prompt.launchContext },
  };
}

async function previewLaunchContextFromProcess(
  agentDir: CreateWorktreeLaunchAgentDir,
): Promise<WorktreeLaunchContextPreviewResult> {
  const normalized = normalizeLaunchAgentDirSelection(agentDir);
  if (!normalized.ok) {
    return {
      ok: false,
      status: 'failed',
      reason: 'invalid-request',
      message: normalized.message,
      recoverable: true,
    };
  }

  if (normalized.agentDir.mode === 'custom') {
    return {
      ok: true,
      status: 'resolved',
      mode: 'custom',
      envAction: 'set',
      effectiveDisplay: shortenHomeDir(normalized.agentDir.customDir),
      provenance: 'request',
      warnings: [],
    };
  }
  if (normalized.agentDir.mode === 'default') {
    return {
      ok: true,
      status: 'resolved',
      mode: 'default',
      envAction: 'unset',
      effectiveDisplay: getPiDefaultAgentDirDisplay(),
      provenance: 'request',
      warnings: [],
    };
  }

  const envValue = process.env['PI_CODING_AGENT_DIR']?.trim();
  return {
    ok: true,
    status: 'resolved',
    mode: 'ambient',
    envAction: 'inherit',
    effectiveDisplay: envValue ? shortenHomeDir(envValue) : getPiDefaultAgentDirDisplay(),
    provenance: envValue ? 'process-env' : 'pi-default',
    warnings: [],
  };
}

function buildWorktreeRequest(
  selection: SessionDeckBrowserSelection,
  selectedIndex: number,
  branchName: string,
  agentDir: CreateWorktreeLaunchAgentDir,
): CreateWorktreeActionRequest {
  const filter = selection.repoOption.filter;
  const selectedRuntimeId = selection.records[selectedIndex]?.runtimeId ?? null;
  return {
    repoIntent: {
      candidateRuntimeIds: selection.records.map((record) => record.runtimeId),
      ...(filter.kind === 'named' && filter.shortLabel.length > 0
        ? { repoName: filter.shortLabel }
        : {}),
      ...(filter.kind === 'named' && filter.qualifiedLabel !== null
        ? { qualifiedRepoName: filter.qualifiedLabel }
        : {}),
      ...(selectedRuntimeId === null ? {} : { preferredRuntimeId: selectedRuntimeId }),
    },
    branchName,
    launch: { mode: 'tmux-detached', agentDir },
  };
}

function formatWorktreePromptLaunchContext(prompt: SessionDeckWorktreePrompt): string {
  if (prompt.launchContext.status === 'loading') {
    return 'Pi config resolving…';
  }
  if (!prompt.launchContext.ok) {
    return 'Pi config unavailable';
  }

  return `Pi config → ${prompt.launchContext.effectiveDisplay}`;
}

function formatWorktreePromptSelector(prompt: SessionDeckWorktreePrompt): string {
  const options = AGENT_DIR_MODE_OPTIONS.map((mode, index) => {
    const label = mode === 'custom' ? 'Custom…' : mode === 'default' ? 'Pi default' : 'Current';
    return index === prompt.selectorIndex ? `› ${label}` : label;
  });
  return `  Choose:    ${options.join('  ·  ')}`;
}

function agentDirModeIndex(mode: CreateWorktreeLaunchAgentDirMode): number {
  return Math.max(0, AGENT_DIR_MODE_OPTIONS.indexOf(mode));
}

function getAgentDirQuickMode(data: string): CreateWorktreeLaunchAgentDirMode | null {
  switch (data.toLowerCase()) {
    case 'a':
      return 'ambient';
    case 'd':
      return 'default';
    case 'c':
      return 'custom';
    default:
      return null;
  }
}

function isTabKey(data: string): boolean {
  return matchesKey(data, 'tab') || data === '\t';
}

function isShiftTabKey(data: string): boolean {
  return matchesKey(data, 'shift+tab') || data === '\u001b[Z';
}

function formatWorktreeResultStatus(result: CreateWorktreeActionResult): {
  message: string;
  tone: 'muted' | 'warning';
} {
  if (!result.ok) {
    if (result.status === 'preflight-failed') {
      return { message: result.preflight.message, tone: 'warning' };
    }
    if (result.status === 'partial-launch-failed') {
      const cause = summarizeLaunchFailure(result.launch.message);
      return {
        message: `Pi did not start.${cause.length === 0 ? '' : ` ${cause}`} The generated worktree was kept. Fix the issue, then press w to retry.`,
        tone: 'warning',
      };
    }
    return { message: result.worktree.message, tone: 'warning' };
  }

  if (!result.launch.requested) {
    return {
      message:
        'Generated worktree is ready, but no Pi session was launched. Retry after updating the create-worktree backend.',
      tone: 'warning',
    };
  }

  if (result.launch.status === 'reused-existing') {
    return { message: 'Reused detached Pi session on the generated worktree.', tone: 'muted' };
  }

  return { message: 'New Pi session launched on the generated worktree.', tone: 'muted' };
}

function summarizeLaunchFailure(message: string): string {
  const trimmed = message.trim();
  if (trimmed.length === 0) {
    return '';
  }

  const withoutPrefix = trimmed.replace(/^Created worktree, but\s+/iu, '');
  return `${withoutPrefix.slice(0, 1).toUpperCase()}${withoutPrefix.slice(1)}`;
}

function isPrintableInput(data: string): boolean {
  return data.length === 1 && data >= ' ' && data !== '\u007f';
}

function renderRepoRow(
  theme: Theme,
  options: SessionDeckRepoOption[],
  selectedIndex: number,
  width: number,
): string {
  if (options.length === 0) {
    return '';
  }

  const windowed = getVisibleWindow(options.length, DEFAULT_MAX_VISIBLE_REPOS, selectedIndex);
  const leftChevron = theme.fg(windowed.start === 0 ? 'dim' : 'muted', '‹');
  const rightChevron = theme.fg(windowed.end >= options.length ? 'dim' : 'muted', '›');
  const labels = options
    .slice(windowed.start, windowed.end)
    .map((option, index) =>
      windowed.start + index === selectedIndex ? theme.fg('accent', option.label) : option.label,
    );

  return layoutRepoRow(leftChevron, labels.join('  '), rightChevron, width);
}

function layoutRepoRow(
  leftChevron: string,
  labelText: string,
  rightChevron: string,
  width: number,
): string {
  const narrowRow = `${leftChevron}${rightChevron}`;
  if (width <= visibleWidth(narrowRow)) {
    return truncateToWidth(narrowRow, width);
  }

  const compactRow = `${leftChevron} ${rightChevron}`;
  if (width <= visibleWidth(compactRow)) {
    return truncateToWidth(compactRow, width);
  }

  const lead = `${leftChevron} `;
  const tail = ` ${rightChevron}`;
  const availableLabelWidth = Math.max(0, width - visibleWidth(lead) - visibleWidth(tail));
  const labels = availableLabelWidth === 0 ? '' : truncateToWidth(labelText, availableLabelWidth);
  return truncateToWidth(`${lead}${labels}${tail}`, width);
}

function renderRowLine1(
  theme: Theme,
  record: SessionDeckBrowserRecord,
  row: SessionDeckBrowserRow,
  isSelected: boolean,
  width: number,
): string {
  const prefix = isSelected ? '› ' : '  ';
  const lead = `${prefix}${row.icon} ${row.activity}  `;
  const coreMetadata = formatRowLine1Metadata(row, false);
  const availableTitleWidth = Math.max(1, width - visibleWidth(lead) - visibleWidth(coreMetadata));
  const title = truncateToWidth(styleRowTitle(theme, record, row, isSelected), availableTitleWidth);
  const line = appendBranchMetadata(
    `${lead}${title}${coreMetadata}`,
    row.branchLabel,
    coreMetadata.length > 0,
  );

  return styleRowLine1(theme, line, record, isSelected, width);
}

function renderRowLine2(
  theme: Theme,
  record: SessionDeckBrowserRecord,
  row: SessionDeckBrowserRow,
  isSelected: boolean,
  width: number,
): string {
  const prefix = isSelected ? theme.fg('accent', '  │ ') : '    ';
  const rowDetail = formatRowLine2Detail(row);
  const chipText = row.hasChips
    ? isSelected || !shouldDimSessionDeckBrowserRow(record)
      ? rowDetail
      : theme.fg('dim', rowDetail)
    : theme.fg('dim', rowDetail);

  return truncateToWidth(`${prefix}${chipText}`, width);
}

function formatRowLine2Detail(row: SessionDeckBrowserRow): string {
  if (row.terminalLabel === null) {
    return row.hasChips ? row.chipPreview : 'no chips';
  }

  return row.hasChips ? `${row.chipPreview} · ${row.terminalLabel}` : row.terminalLabel;
}

function formatRowLine1Metadata(row: SessionDeckBrowserRow, includeBranch: boolean): string {
  const tokens = [
    row.repoLabel,
    row.prLabel,
    row.ageLabel,
    ...(includeBranch ? [row.branchLabel] : []),
  ].filter((token): token is string => token !== null);

  return tokens.length === 0 ? '' : `  ${tokens.join(' · ')}`;
}

function appendBranchMetadata(
  line: string,
  branchLabel: string | null,
  hasCoreMetadata: boolean,
): string {
  if (branchLabel === null) {
    return line;
  }

  return `${line}${hasCoreMetadata ? ' · ' : '  '}${branchLabel}`;
}

function styleRowTitle(
  theme: Theme,
  record: SessionDeckBrowserRecord,
  row: SessionDeckBrowserRow,
  isSelected: boolean,
): string {
  if (isSelected || shouldDimSessionDeckBrowserRow(record) || row.titleSource !== 'sessionName') {
    return row.title;
  }

  return theme.fg('accent', row.title);
}

function styleRowLine1(
  theme: Theme,
  line: string,
  record: SessionDeckBrowserRecord,
  isSelected: boolean,
  width: number,
): string {
  const truncatedLine = truncateToWidth(line, width);

  if (isSelected) {
    return theme.fg('accent', truncatedLine);
  }

  if (shouldDimSessionDeckBrowserRow(record)) {
    return theme.fg('dim', truncatedLine);
  }

  return truncatedLine;
}

function pushWrappedLine(lines: string[], line: string, width: number, prefix = ''): void {
  const prefixWidth = visibleWidth(prefix);
  if (width <= prefixWidth) {
    lines.push(truncateToWidth(prefix, width));
    return;
  }

  const wrapped = wrapTextWithAnsi(line, Math.max(1, width - prefixWidth));
  if (wrapped.length === 0) {
    lines.push(truncateToWidth(prefix, width));
    return;
  }

  const continuationPrefix = ' '.repeat(prefixWidth);
  for (const [index, segment] of wrapped.entries()) {
    const currentPrefix = index === 0 ? prefix : continuationPrefix;
    lines.push(truncateToWidth(`${currentPrefix}${segment}`, width));
  }
}

function pushBoxedLines(lines: string[], contentLines: string[], width: number): void {
  if (width <= 4) {
    for (const line of contentLines) {
      pushWrappedLine(lines, line, width, '  ');
    }
    return;
  }

  const innerWidth = Math.max(1, width - 4);
  lines.push(truncateToWidth(`┌${'─'.repeat(Math.max(0, width - 2))}┐`, width));

  if (contentLines.length === 0) {
    lines.push(truncateToWidth(`│ ${' '.repeat(innerWidth)} │`, width));
  } else {
    for (const line of contentLines) {
      pushBoxedWrappedLine(lines, line, width, innerWidth);
    }
  }

  lines.push(truncateToWidth(`└${'─'.repeat(Math.max(0, width - 2))}┘`, width));
}

function pushBoxedWrappedLine(
  lines: string[],
  line: string,
  width: number,
  innerWidth: number,
): void {
  if (line.length === 0) {
    lines.push(truncateToWidth(`│ ${' '.repeat(innerWidth)} │`, width));
    return;
  }

  const wrapped = wrapTextWithAnsi(line, innerWidth);
  if (wrapped.length === 0) {
    lines.push(truncateToWidth(`│ ${' '.repeat(innerWidth)} │`, width));
    return;
  }

  for (const segment of wrapped) {
    lines.push(truncateToWidth(`│ ${padToVisibleWidth(segment, innerWidth)} │`, width));
  }
}

function padToVisibleWidth(line: string, width: number): string {
  const padding = Math.max(0, width - visibleWidth(line));
  return `${line}${' '.repeat(padding)}`;
}

function getVisibleWindow(
  total: number,
  maxVisible: number,
  selectedIndex: number,
): {
  start: number;
  end: number;
} {
  if (total <= maxVisible) {
    return { start: 0, end: total };
  }

  const half = Math.floor(maxVisible / 2);
  const start = Math.max(0, Math.min(selectedIndex - half, total - maxVisible));
  return {
    start,
    end: Math.min(total, start + maxVisible),
  };
}

function buildRepoState(records: SessionDeckBrowserRecord[]): SessionDeckRepoState {
  const recordsByKey = new Map<SessionDeckRepoKey, SessionDeckBrowserRecord[]>([
    [ALL_REPO_FILTER_KEY, records],
  ]);
  const repoGroups = new Map<string, SessionDeckPendingRepoGroup>();
  let noRepoRecords: SessionDeckBrowserRecord[] | null = null;

  for (const record of records) {
    const shortLabel = getRecordShortRepoLabel(record);
    if (shortLabel === null) {
      noRepoRecords ??= [];
      noRepoRecords.push(record);
      continue;
    }

    let group = repoGroups.get(shortLabel);
    if (group === undefined) {
      group = {
        shortLabel,
        qualifiedLabels: new Set<string>(),
        records: [],
      };
      repoGroups.set(shortLabel, group);
    }

    if (record.qualifiedRepoName !== null) {
      group.qualifiedLabels.add(record.qualifiedRepoName);
    }

    group.records.push(record);
  }

  const namedBuckets = [...repoGroups.values()]
    .flatMap(buildNamedRepoBuckets)
    .sort(compareRepoBuckets);
  const shortLabelCounts = countShortRepoLabels(namedBuckets);
  const options: SessionDeckRepoOption[] = [
    { key: ALL_REPO_FILTER_KEY, label: 'all', filter: { kind: 'all' } },
  ];

  for (const bucket of namedBuckets) {
    const label =
      (shortLabelCounts.get(bucket.shortLabel) ?? 0) > 1 && bucket.qualifiedLabel !== null
        ? bucket.qualifiedLabel
        : bucket.shortLabel;
    recordsByKey.set(bucket.key, bucket.records);
    options.push({
      key: bucket.key,
      label,
      filter: {
        kind: 'named',
        key: bucket.key,
        shortLabel: bucket.shortLabel,
        qualifiedLabel: bucket.qualifiedLabel,
      },
    });
  }

  if (noRepoRecords !== null && noRepoRecords.length > 0) {
    recordsByKey.set(NO_REPO_FILTER_KEY, noRepoRecords);
    options.push({ key: NO_REPO_FILTER_KEY, label: 'N/A', filter: { kind: 'no-repo' } });
  }

  return { options, recordsByKey };
}

function buildNamedRepoBuckets(group: SessionDeckPendingRepoGroup): SessionDeckNamedRepoBucket[] {
  if (group.qualifiedLabels.size <= 1) {
    const qualifiedLabel = group.qualifiedLabels.values().next().value ?? null;
    return [
      {
        key: group.shortLabel,
        shortLabel: group.shortLabel,
        qualifiedLabel,
        records: group.records,
      },
    ];
  }

  const qualifiedBuckets = new Map<string, SessionDeckNamedRepoBucket>();
  const unqualifiedRecords: SessionDeckBrowserRecord[] = [];

  for (const record of group.records) {
    if (record.qualifiedRepoName === null) {
      unqualifiedRecords.push(record);
      continue;
    }

    let bucket = qualifiedBuckets.get(record.qualifiedRepoName);
    if (bucket === undefined) {
      bucket = {
        key: record.qualifiedRepoName,
        shortLabel: group.shortLabel,
        qualifiedLabel: record.qualifiedRepoName,
        records: [],
      };
      qualifiedBuckets.set(record.qualifiedRepoName, bucket);
    }

    bucket.records.push(record);
  }

  return [
    ...qualifiedBuckets.values(),
    ...(unqualifiedRecords.length === 0
      ? []
      : [
          {
            key: group.shortLabel,
            shortLabel: group.shortLabel,
            qualifiedLabel: null,
            records: unqualifiedRecords,
          },
        ]),
  ];
}

function getRepoSelection(
  repoState: SessionDeckRepoState,
  selectedRepoKey: SessionDeckRepoKey,
): SessionDeckBrowserSelection {
  const repoIndex = repoState.options.findIndex((option) => option.key === selectedRepoKey);
  const resolvedRepoIndex = repoIndex === -1 ? 0 : repoIndex;
  const repoOption = repoState.options[resolvedRepoIndex] ?? {
    key: ALL_REPO_FILTER_KEY,
    label: 'all',
    filter: { kind: 'all' } as const,
  };

  return {
    repoState,
    repoIndex: resolvedRepoIndex,
    repoOption,
    records: getRepoRecords(repoState.recordsByKey, repoOption.key),
  };
}

function getRepoRecords(
  recordsByKey: Map<SessionDeckRepoKey, SessionDeckBrowserRecord[]>,
  repoKey: SessionDeckRepoKey,
): SessionDeckBrowserRecord[] {
  return recordsByKey.get(repoKey) ?? recordsByKey.get(ALL_REPO_FILTER_KEY) ?? [];
}

function countShortRepoLabels(buckets: Array<{ shortLabel: string }>): Map<string, number> {
  return buckets.reduce<Map<string, number>>((counts, bucket) => {
    counts.set(bucket.shortLabel, (counts.get(bucket.shortLabel) ?? 0) + 1);
    return counts;
  }, new Map());
}

function compareRepoBuckets(
  left: { key: string; shortLabel: string },
  right: { key: string; shortLabel: string },
): number {
  return (
    left.shortLabel.localeCompare(right.shortLabel, undefined, { sensitivity: 'base' }) ||
    left.key.localeCompare(right.key)
  );
}

function getRecordShortRepoLabel(record: SessionDeckBrowserRecord): string | null {
  if (record.repoName !== null) {
    return record.repoName;
  }

  if (record.qualifiedRepoName !== null) {
    return getShortRepoLabelFromKey(record.qualifiedRepoName);
  }

  return null;
}

function getShortRepoLabelFromKey(repoKey: string): string {
  const separatorIndex = repoKey.lastIndexOf('/');
  if (separatorIndex === -1 || separatorIndex === repoKey.length - 1) {
    return repoKey;
  }

  return repoKey.slice(separatorIndex + 1);
}

function getPreservedRepoOption(
  repoState: SessionDeckRepoState,
  filter: SessionDeckRepoFilter,
): SessionDeckRepoOption {
  if (filter.kind === 'all') {
    return repoState.options[0]!;
  }

  if (filter.kind === 'no-repo') {
    return (
      repoState.options.find((option) => option.key === NO_REPO_FILTER_KEY) ?? repoState.options[0]!
    );
  }

  if (filter.qualifiedLabel !== null) {
    const qualifiedMatch = repoState.options.find(
      (option): option is SessionDeckRepoOption & { filter: SessionDeckNamedRepoFilter } =>
        option.filter.kind === 'named' && option.filter.qualifiedLabel === filter.qualifiedLabel,
    );
    if (qualifiedMatch !== undefined) {
      return qualifiedMatch;
    }
  }

  const shortLabelMatches = repoState.options.filter(
    (option): option is SessionDeckRepoOption & { filter: SessionDeckNamedRepoFilter } =>
      option.filter.kind === 'named' && option.filter.shortLabel === filter.shortLabel,
  );
  if (shortLabelMatches.length === 1) {
    return shortLabelMatches[0]!;
  }

  return (
    repoState.options.find(
      (option): option is SessionDeckRepoOption & { filter: SessionDeckNamedRepoFilter } =>
        option.filter.kind === 'named' && option.filter.key === filter.key,
    ) ?? repoState.options[0]!
  );
}

function findSelectedIndex(records: SessionDeckBrowserRecord[], runtimeId: string | null): number {
  if (runtimeId === null) {
    return clampIndex(0, records.length);
  }

  const matchedIndex = records.findIndex((record) => record.runtimeId === runtimeId);
  return matchedIndex === -1 ? clampIndex(0, records.length) : matchedIndex;
}

function clampIndex(index: number, length: number): number {
  if (length <= 0) {
    return 0;
  }

  return Math.max(0, Math.min(length - 1, index));
}

function formatShortRuntimeId(runtimeId: string): string {
  return runtimeId.length <= 8 ? runtimeId : runtimeId.slice(0, 8);
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

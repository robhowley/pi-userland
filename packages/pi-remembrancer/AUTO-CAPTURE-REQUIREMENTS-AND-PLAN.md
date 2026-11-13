# Additive automatic capture: requirements and implementation plan

Add opt-in automatic capture on a fresh branch from `main`. Preserve the existing manual workflow with capture off **and** on. Use PR #235 as a source of reusable code, not as the new branch's starting point.

## Status and source of truth

- This document is an implementation handoff, not an implementation or permission to publish a PR.
- The user explicitly chose backward-compatible, additive behavior. Automatic capture does not replace manual review.
- Inspected `main`: `f1ee2267ace546d1636048ee9468621fd8eb983e`; remote `main` matched during planning.
- Donor: [PR #235](https://github.com/robhowley/pi-userland/pull/235), `d012f37a6fb7eabd3ee1d23587b54150b740317c`.
- Fetch current `main` when implementation begins and record the actual base. Reconcile intervening changes without weakening the requirements below.
- This plan supersedes earlier instructions to make manual `finish` save proposals before approval, reject partial manual reviews, or expire manual reviews after five idle minutes.
- All paths below are relative to `packages/pi-remembrancer/` unless stated otherwise.

## 1. Non-negotiable behavior

### Settings and entry points

Enable capture through the existing applicable Pi `settings.json`:

```json
{
  "pi-remembrancer": {
    "autoCapture": true
  }
}
```

| Effective setting               | Manual review                                                      | Automatic capture                                | Previously saved proposals                           |
| ------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------ | ---------------------------------------------------- |
| `autoCapture` absent or `false` | Existing behavior                                                  | No shutdown analysis                             | Reminder and proposal UI remain available            |
| `autoCapture: true`             | Same existing behavior                                             | Outgoing eligible session at shutdown boundaries | Reminder and proposal UI available                   |
| `disabled: true`                | Preserve existing extension-disable behavior and reload convention | Disabled, regardless of capture flag             | Extension reminder/UI disabled; stored data retained |

- **R1:** Default `autoCapture` to `false`; retain `disabled: false` as the extension default. No new mode flag or configuration migration.
- **R2:** Preserve per-setting global/trusted-project precedence and ignore untrusted project settings. Effective `disabled` wins over capture.
- **R3:** Re-read capture settings at outgoing shutdown. Enabling before shutdown includes eligible evidence already written in that session; disabling skips capture.
- **R4:** Startup only reads the local pending count for the reminder, such as `3 task proposals · /remembrancer proposals`; no model, transcript scan, or Taskwarrior call.

### Manual compatibility

- **M1:** Keep `remembrancer_review` actions `begin`, `next`, `context`, `finish`, and `cancel`, their arguments, response shapes, errors, and existing exports compatible with `main`.
- **M2:** `{ "action": "finish", "batch": "..." }` remains valid. Do not require `proposals`, a new flag, an approval token, or a TUI for manual completion.
- **M3:** Preserve the skill's manual sequence: analyze available evidence, present suggestions, user accepts/edits/dismisses, apply and verify accepted changes, then finish coverage. Do not advance coverage while decisions remain unresolved under that workflow.
- **M4:** Preserve healthy-source partial completion, warnings and `status: "partial"`; unavailable sources remain unreviewed. Both complete and partial manual reviews must consume every available evidence continuation before finish.
- **M5:** Preserve current-conversation wrap-up, direct task requests, saved-session review, seed discovery and cutoff rules, branch/edit handling, and frozen context. Direct task requests do not advance review coverage.
- **M6:** Human approval waits have no new five-minute expiry. A live manual review retains ownership until finish, cancel, shutdown, or process death; another review cannot take over while it remains live.
- **M7:** Preserve `CheckpointStore.finish(tips)` and `finish(plan)` and existing source/default/checkpoint migration and rollback behavior. Do not replay previously covered evidence or backfill proposals on upgrade.
- **M8:** Preserve existing non-TUI manual capability and the skill's restriction that delegated workers return suggestions rather than write personal tasks. TUI-only guards belong to the new capture/proposal-application paths.
- **M9:** Cancelling or abandoning manual review does not save coverage or undo task changes already applied. Keep existing reporting and task rechecks for those cases.

### Automatic capture

- **A1:** Run only for a saved outgoing TUI session on clean quit, reload, new session, resume, or fork. Skip unsaved, RPC, JSON, print, headless and unknown modes. TUI mode is not proof of human authorship or worker identity.
- **A2:** Inspect only that session file using existing checkpoint/default eligibility. No archive discovery, other enrolled transcripts, per-turn capture, enable-time cutoff, or detached background work.
- **A3:** Freeze user/assistant text, branches, edits and the coverage plan once. Exclude tool outputs, thinking and images. Later appends/edits stay eligible. With no eligible evidence, call no reviewer and commit no capture coverage/source changes.
- **A4:** Use a temporary in-memory SDK session with the outgoing selected model and normal SDK provider/auth configuration. Load no personal extensions, skills, prompt files, AGENTS files, or parent transcript. No model fallback, retries, or compaction.
- **A5:** Supply only scoped evidence/context reads, fixed read-only task lookups, stored-proposal reads, and final submission. Historical text is untrusted evidence, never authorization or instructions.
- **A6:** Require an explicit proposal array, including `[]`, submitted exactly once and alone in its tool batch. Validate all continuations delivered, complete source scope, supported changes, exact eligible quotes/offsets/branch/edit identity, and proposal revisions. Supporting context cannot supply new extraction evidence.
- **A7:** Stage submissions in memory. Commit proposals and examined coverage together only after normal reviewer completion, awaited cleanup and a deadline check. Automatic analysis never applies Taskwarrior changes.
- **A8:** Start the five-minute review/cancellation budget at shutdown entry. At expiry request cancellation and await cleanup, even beyond five minutes or indefinitely. Reject late output; never detach, retry, compact, or partially commit an oversized/failed review.
- **A9:** On detected failure, report the outgoing session ID and save neither proposals nor coverage. A crash/forced kill may prevent the notice. Manual catch-up remains available for unreviewed evidence.

### Proposal review and application

- **P1:** Keep durable pending proposals, edited drafts, revision history, dismissals, application claims and outcomes in the existing local SQLite database; retain existing private-file protections.
- **P2:** `/remembrancer proposals` is an additive, model-free TUI command, available independently of `autoCapture` and subject to `disabled`.
- **P3:** Show exact proposed changes, the actual target task, explanation and saved quotes. Edit saves a draft; Dismiss changes one proposal; Source reads only referenced files lazily for bounded context on the saved branch.
- **P4:** Preserve exact saved quotes when files are missing/stale. Source uses up to two messages before/after and the existing display limits; preview/navigation must not read source files or scan the archive.
- **P5:** Only deliberate per-item `Ctrl+A` applies a displayed change. Enter, navigation, editing, Source and closing never apply tasks; no accept-all.
- **P6:** Recheck task and proposal against the displayed preview; changes require refreshed approval. Claim before writing, send typed JSON to Taskwarrior, export and verify, then record the outcome. Unresolved questions block application.
- **P7:** Taskwarrior and SQLite are not one transaction. Interrupted/uncertain writes are not replayed; explicit resolution only verifies an already-present result. Otherwise direct the user to resolve it manually. External edits can still race the final check.

### How the two workflows coexist

- A successful manual finish and a successful automatic capture update the same coverage, so unchanged evidence is not analyzed again.
- Pending automatic proposals remain a separate queue after their evidence is covered. Turning capture off does not hide or discard them.
- Manual review continues to examine eligible unreviewed evidence. It does not silently become a replay or bulk application of the proposal queue; ordinary manual finish never changes stored proposal decisions.
- Preserve the existing manual tool schema; do not port the donor's new manual `proposals` action merely to integrate the automatic reviewer, which has its own lookup tool.
- If a task is handled conversationally, a related queued proposal may remain pending. The user can inspect/dismiss/edit it in the UI. For a pending add whose task was created elsewhere, do not promise UUID-based verification will detect a semantic duplicate.
- Task/proposal matching is a model judgment, not a guaranteed obligation identity. Cross-path decision synchronization or exactly-once semantic deduplication is not part of this rebuild.

## 2. What to borrow from PR #235

Use the pinned donor commit and inspect each imported diff. Do not cherry-pick its four commits wholesale.

| Donor file                                  | Treatment                               | Requirement                                                                                                                                                       |
| ------------------------------------------- | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `extensions/remembrancer/reviewer.ts`       | Copy, then verify                       | Keep isolated SDK startup, restricted resources/tools, mixed-submission rejection and awaited cancellation/disposal.                                              |
| `extensions/remembrancer/proposals.ts`      | Copy, then verify                       | Keep typed proposals, states, supported task snapshots and exact frozen-evidence reference validation.                                                            |
| `extensions/remembrancer/taskwarrior.ts`    | Copy against proposal storage API       | Keep fixed reads, typed writes, fresh approval, claims, verification and no-replay resolution. Do not route old direct/manual task operations through it.         |
| `extensions/remembrancer/proposal-ui.ts`    | Copy; adapt paging import               | Preserve deliberate per-item approval, drafts/history, exact previews and lazy bounded Source context.                                                            |
| `extensions/remembrancer/config.ts`         | Port the setting addition               | Keep `main`'s disabled behavior; add only the capture flag and per-field precedence.                                                                              |
| `extensions/remembrancer/capture.ts`        | Adapt                                   | Keep eligibility, tools, staging, deadlines and cleanup; replace expiring-lease/manual-engine dependencies with capture-only state and the existing process lock. |
| `extensions/remembrancer/review.ts`         | Select functions only                   | Reuse pure paging/context and automatic frozen-review logic; do not install donor `AnalysisReview` as the manual engine.                                          |
| `extensions/remembrancer/checkpoints.ts`    | Select schema/methods only              | Port proposal table, revisions, drafts, history, claims and outcomes; add capture-only atomic completion. Keep base lock and manual `finish` APIs.                |
| `extensions/remembrancer/index.ts`          | Select wiring only                      | Add command/completions, pending reminder and awaited capture shutdown hook. Preserve manual tool schema, handlers, responses and exports.                        |
| `README.md`, `skills/remembrancer/SKILL.md` | Add sections, not wholesale replacement | Document opt-in capture/UI alongside unchanged manual instructions and authorization rules.                                                                       |

**Do not import:** `review_lease`, expiring manual ownership, required manual proposal submissions, forced manual UI approval, blanket incomplete-review rejection, manual `finish` changing to analysis-only, or removal of the delegated-write restriction.

### Tests to borrow

| Test source                                  | Keep                                                                                                                                               | Adapt or reject                                                                                                  |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `reviewer.test.ts`                           | Isolation, tool restrictions, setup/prompt errors, mixed batches, cancellation races and cleanup                                                   | Adapt only necessary API fixtures.                                                                               |
| `capture-sdk.test.ts`                        | Installed SDK with deterministic localhost transport, correct tool surface, no parent transcript preload, valid/mixed submission outcomes          | No live credentials or personal config.                                                                          |
| `capture.test.ts`                            | Opt-in/mode gates, source-only eligibility, pre-opt-in evidence, frozen appends, staging/cleanup ordering, contention, timeouts and no late commit | Use the base manual finish in fixtures; replace expired-successor-lease tests with process-lock ownership tests. |
| `proposals.test.ts`                          | Atomic rollback, stale revisions, drafts/history/restart, claims and exact provenance validation                                                   | Enforce complete-source/delivery rules only for capture completion, not manual finish.                           |
| `taskwarrior.test.ts`                        | Fresh previews, concurrent claims, typed writes, actual-record verification, no replay, Source bounds and non-writing UI actions                   | Keep external effects isolated.                                                                                  |
| Donor `extension.test.ts` additions          | Proposal command, startup count and opt-in wiring                                                                                                  | Reject the test requiring manual proposals and replacements that prohibit partial manual finish.                 |
| Base manual/evidence/checkpoint/config tests | Preserve existing behavioral assertions                                                                                                            | Add cases; do not delete, skip, or weaken them to accommodate the feature.                                       |

## 3. Minimal implementation design

### One review lock, not two protocols

Keep `main`'s separate SQLite `.lock` transaction and existing `claimReview()`/`releaseReview()` behavior. Both manual review and automatic capture acquire it before preparing evidence. It also coordinates with already-running baseline processes using that same lock path.

- Hold capture ownership through SDK cleanup, final deadline check and commit; release in `finally`.
- A busy lock produces a capture failure notice without a reviewer call or coverage change; do not queue a retry.
- Keep ordinary source enrollment possible while a review owns the separate lock.
- The automatic deadline cancels automatic work; it does not expire ownership or permit another process to replace a still-running reviewer.
- On outgoing shutdown, abandon any open manual batch as `main` does, without saving its coverage; then attempt opt-in capture, and close the database only after capture cleanup.

### Share data operations without replacing manual completion

Keep manual `Batch` and tool lifecycle in `index.ts`. The only proposed extraction is existing paging/context code into a shared module such as `review-pages.ts`, with existing `index.ts` exports re-exported unchanged. Preserve the 50 KiB response cap, 48,000 text-unit/200-entry limits, continuation offsets, group ordering and frozen-context semantics.

Use a capture-only component, such as `capture-review.ts`, to prepare one source, freeze eligible evidence and coverage, track complete delivery, and validate submitted proposals. It may use an in-memory capture identity to associate operations with that frozen batch; that identity is not an expiring database lease.

In `checkpoints.ts`:

1. Add the proposal table and proposal methods without changing existing rows, source defaults, migrations, or unknown tables.
2. Keep public manual `finish(tips)` and `finish(plan)` compatible, including healthy-source partial completion.
3. Extract only the existing normalized coverage-write body into a private helper that does not begin/commit transactions.
4. Add a separate operation, for example `finishCapture(captureId, submissions)`, using a frozen plan produced by trusted source preparation, not a plan supplied by the model.
5. Capture completion checks active ownership/identity, complete delivery/scope and exact submissions; one transaction saves proposals plus sources/defaults/checkpoints, rechecking proposal revisions before saving.
6. Any failure rolls back the whole automatic transaction. Never save proposals and then call public manual `finish`, or call transaction-owning `finish` inside another transaction.

Keep transaction ownership and capture validation in one place. Do not add feature-flag branches to manual page/context/finish behavior.

## 4. Implementation phases and acceptance gates

### Phase 0: new branch and baseline

1. Keep the donor branch/PR intact. Fetch `main`, choose an unused worktree/branch name such as `remem-auto-capture-additive`, and create it from `origin/main`, not the donor head.
2. Copy this plan into that worktree and record its actual base SHA. Do not carry other donor files or commits implicitly.
3. Read current package instructions, relevant Pi SDK/lifecycle docs and examples before implementation. No harness, dependency, manifest, lockfile or unrelated-package changes are expected; surface any genuine need before expanding scope.
4. Run and record the package's existing tests, lint, types and formatting. Distinguish pre-existing failures from feature regressions.

**Gate:** clean baseline recorded; existing manual assertions identified and retained.

### Phase 1: compatibility tests and minimal shared helpers

1. Add manual regression cases for absent/false/true capture settings, old finish payload, partial readable/unreadable sources, and approval waits beyond five minutes.
2. Add process-level lock tests for manual/capture exclusion, allowed enrollment, normal release and process-death release.
3. If needed, mechanically extract paging/context functions with unchanged exports and responses. Do not replace the manual engine.

**Gate:** existing manual tests plus new compatibility/lock tests pass; no automatic analysis or proposal requirements enter manual calls.

### Phase 2: proposal persistence and capture-only completion

1. Port `proposals.ts`, proposal schema/CRUD/history/claim/outcome methods, and the relevant tests.
2. Add the small private coverage writer and distinct capture completion operation described above.
3. Add capture-only frozen-source/delivery validation using existing evidence preparation and shared helpers.
4. Prove rollback for invalid references, unread continuations, incomplete capture scope, stale proposal revisions and storage failures.

**Gate:** manual finish still supports partial scope; automatic proposals and coverage commit together or neither; restart preserves drafts, decisions and claims.

### Phase 3: isolated reviewer and opt-in shutdown integration

1. Port `reviewer.ts` and its tests; adapt `capture.ts` to the existing lock and capture-only completion.
2. Add `autoCapture` config/default/precedence tests; register manual review independently of that setting.
3. Wire outgoing shutdown with a budget measured from handler entry, manual-batch abandonment, awaited capture and final database close.
4. Run deterministic SDK integration and capture tests for mode eligibility, settings reread, scoped evidence, staging, timeout, cleanup and unchanged transcripts.

**Gate:** capture off starts no reviewer; capture on never changes Taskwarrior; failure saves nothing; late output never commits; manual behavior stays the same.

### Phase 4: independent proposal UI and verified application

1. Port `taskwarrior.ts` and `proposal-ui.ts` against the proposal storage methods and shared pager.
2. Add `/remembrancer proposals`, completions and the local pending-count startup reminder without making them depend on capture being on.
3. Verify exact previews, lazy Source context, drafts/dismissals, Enter/navigation safety, concurrent claims, stale-preview approval, actual write verification and uncertain no-replay handling.
4. Document that pending proposals remain separate from the manual conversation flow and are not silently consumed by manual finish.

**Gate:** no inferred task mutation without deliberate per-item approval; stored proposals remain inspectable after capture is turned off.

### Phase 5: documentation, independent verification and submission

1. Preserve `main`'s manual instructions; add clearly separate automatic capture, settings, limitations and proposal-UI sections.
2. Run the full validation matrix below and the normal package checks. Inspect the final diff against the recorded new base, not against the donor branch.
3. An independent verifier compares the unchanged manual API/skill behavior and original regression assertions with `main`; it must not judge success solely by donor test counts.
4. Route any failures to a fix worker, then rerun independent verification. Stop for user clarification if a proposed fix changes the manual contract or adds product scope.
5. If asked to submit, open a new additive feature PR with no `!` once compatibility is demonstrated; reference PR #235 as the donor. Do not close, force-push, or replace the old PR without permission.

**Gate:** report exact checks and limitations. A clean package run does not establish live-provider quality or merge readiness.

## 5. Required validation matrix

| Area                     | Required proof                                                                                                                                                                                          |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Default behavior         | Absent/false flag: no automatic reviewer; manual API and conversational flow remain compatible.                                                                                                         |
| Opt-in behavior          | True flag adds capture without changing manual results; global/trusted-project precedence, invalid values, effective disabled and shutdown reread behave as documented.                                 |
| Manual finish            | Old payload and both store overloads work; empty batches, partial healthy coverage, warnings, seed defaults and unread-page rejection retain baseline behavior.                                         |
| Ownership                | Manual approval wait beyond five minutes succeeds; competing manual/automatic processes cannot overlap; enrollment works; finish/cancel/shutdown/crash release the lock.                                |
| Eligibility              | Only outgoing saved TUI file; no archive/other sources; eligible pre-opt-in text included; covered evidence skipped; no-evidence path makes no model call or capture commit.                            |
| Frozen evidence          | Later appends/edits excluded, exact branch/edit/offset/quote validation, context not extraction scope, all continuations required.                                                                      |
| Automatic commit         | Empty explicit result valid; malformed/missing/mixed/duplicate submission, incomplete scope, stale revision, overflow, timeout, setup/tool/cleanup/storage failure save neither proposals nor coverage. |
| Cancellation             | Cleanup is awaited, database remains open until cleanup ends, late output rejected, no retry/detached work; notification failure still releases resources.                                              |
| Manual/automatic sharing | Successful manual finish prevents automatic replay; automatic coverage prevents transcript replay in manual review; pending proposals remain visible and unchanged by manual finish.                    |
| Proposal persistence     | Reopen preserves drafts, history, dismissals and uncertain claims; later evidence cannot silently overwrite an edited draft; revisions protect concurrent decisions.                                    |
| Approval and writes      | No Enter/Source/navigation/edit/close task writes; exact stale-preview reapproval; claim before write; actual-record verification; no blind replay after external success/local-save failure.           |
| Source and reminder      | Saved quotes survive missing/stale files; context remains bounded and lazy; startup count uses no model/transcript/Taskwarrior; UI and count work with capture off.                                     |
| Authorization            | Direct/manual task requests retain existing authorization rules; automatic reviewer cannot write tasks or run arbitrary commands; delegated-write restriction retained.                                 |

### Commands and isolation

Run from the package directory in the **new** worktree. Use `structured_return` with the indicated parser for the underlying tools, matching package script scopes:

| Check      | Command                                                                                                                          | Parser           |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| Tests      | `pnpm exec vitest run __tests__ --reporter=json`                                                                                 | `vitest-json`    |
| Lint       | `pnpm exec eslint extensions/ __tests__/ -f json`                                                                                | `eslint-json`    |
| Types      | `pnpm exec tsc --noEmit --pretty false`                                                                                          | `tsc-text`       |
| Formatting | `pnpm exec prettier --check extensions/ __tests__/ README.md skills/remembrancer/SKILL.md AUTO-CAPTURE-REQUIREMENTS-AND-PLAN.md` | `prettier-text`  |
| Whitespace | `git diff --check`                                                                                                               | Plain git output |
| Scope      | `git diff --stat <recorded-base>...HEAD` plus working-tree diff/status                                                           | Plain git output |

Run narrow tests during each phase, then the full package suite. Preserve baseline assertions; fixture setup may change only without weakening what they prove.

- Tests use temporary transcripts/databases and isolated `HOME`, `XDG_STATE_HOME`, Pi agent config, `TASKRC` and `TASKDATA` as applicable.
- Use fake Taskwarrior executors or explicitly isolated CLI storage; never inspect or mutate personal tasks as a test.
- Use deterministic localhost SDK transport for automated integration, with no real credentials, external provider requests or personal settings.
- Real-provider or live-terminal smoke tests are separate, explicitly authorized checks; report if not performed. Never claim perfect obligation recognition or bounded cancellation cleanup.

## 6. Worker handoff rules

- Main coordinator owns the compatibility requirements and gates. No worker may reinterpret opt-in as permission to replace manual review.
- Implement phases 0–3 serially because they share review/storage ownership. Phase 4 follows stable proposal APIs; isolated worktrees are required for any parallel mutation.
- Give each worker this plan, its assigned phase, the recorded base/donor SHAs, permitted files and acceptance tests. Later phases are out of scope until their prerequisites pass.
- Preserve read-only research artifacts; use independent verifier → fix worker → final verifier when checks fail. Do not weaken tests to obtain a pass.
- Do not push, publish, change personal settings/tasks, or close the donor PR without authorization.

## 7. Evidence and planning limits

The implementation has not started. This document was synthesized from independent baseline and donor-reuse research, followed by a narrower integration analysis after one integration worker timed out.

Research artifacts:

- Baseline: `/Users/roberthowley/.pi/subagent-runs/20261111T171208Z-ffjwxxsa/01-scout-luna.md`.
- Donor map: `/Users/roberthowley/.pi/subagent-runs/20261111T171208Z-ffjwxxsa/02-worker-normal.md`.
- Integration: `/Users/roberthowley/.pi/subagent-runs/20261111T172759Z-xsr3ayvb/result.md`.

Primary code anchors: baseline `index.ts:609–701` (manual API/completion), baseline `checkpoints.ts:95–239` (process lock and finish), donor `capture.ts:18–170` (automatic lifetime), donor `checkpoints.ts:196–344,395–519` (proposal persistence/atomic finish), and both versions of the manual skill. Recheck anchors against the recorded SHAs, not a future moving branch.

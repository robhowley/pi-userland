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

## 8. Execution record

### Phase 0: setup and baseline (2026-11-11)

- Fetched `origin/main`; actual base: `f1ee2267ace546d1636048ee9468621fd8eb983e`.
- Retained the precreated, clean `remem-auto-v2` branch because its HEAD exactly matched fetched `origin/main`. No reset, overwrite, or donor-based branch creation occurred.
- Worktree: `/Users/roberthowley/.pi/cmux-junction-worktrees/robhowley-pi-userland-remem-auto-v2`.
- Donor object `d012f37a6fb7eabd3ee1d23587b54150b740317c` was already available locally. No donor ref fetch, branch change, or PR mutation was needed.
- Requirements above are copied unchanged from `/tmp/pi-remembrancer-additive-plan-2026-11-11.md`.
- Setup only: ignored root dependency link to existing monorepo tooling and package-local peer links to installed Pi 1.5.0. No dependency installation or manifest/lockfile changes.
- Baseline checks run with isolated temporary HOME, XDG state/config, Pi agent config, TASKRC, and TASKDATA. No personal tasks/settings or real providers are used.
- Isolation root: `/tmp/pi-remembrancer-phase0.Nnrqpd` (subdirectories `home`, `state`, `config`, `agent`, `taskdata`; empty `taskrc`).

#### Baseline results

All commands below ran from this worktree's `packages/pi-remembrancer/`, through `structured_return`, with the isolation environment above. Artifact paths are relative to that directory.

| Check             | Command                                                                                                                          | Result                                                                                                                           | Artifact                                                                 |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Tests             | `pnpm exec vitest run __tests__ --reporter=json`                                                                                 | Failed: 75 assertions passed, but `extension.test.ts` and `render.test.ts` failed during suite loading; JSON `success` is false. | `.pi/structured-returns/42fa9c5a-c737-4f08-bd06-db9501f6291d.stdout.log` |
| Lint              | `pnpm exec eslint extensions/ __tests__/ -f json`                                                                                | Passed: 17 files, zero errors/warnings.                                                                                          | `.pi/structured-returns/5ceb72f8-362a-4e7a-9857-cb35c137732e.stdout.log` |
| Types             | `pnpm exec tsc --noEmit --pretty false`                                                                                          | Failed: three pre-existing Pi 1.5.0 compatibility errors.                                                                        | `.pi/structured-returns/7564664c-4367-49b0-89b6-e7d214a7d6b5.stdout.log` |
| Script formatting | `pnpm exec prettier --check extensions/ __tests__/`                                                                              | Passed.                                                                                                                          | Formatting artifacts listed below.                                       |
| Plan formatting   | `pnpm exec prettier --check extensions/ __tests__/ README.md skills/remembrancer/SKILL.md AUTO-CAPTURE-REQUIREMENTS-AND-PLAN.md` | Passed initially; final rerun recorded in the phase-0 transcript.                                                                | Formatting artifacts listed below.                                       |
| Whitespace/scope  | `git diff --check`; `git diff --stat f1ee2267ace546d1636048ee9468621fd8eb983e...HEAD`; working-tree diff/status                  | Passed; no committed changes, only this new plan is untracked.                                                                   | Git output in phase-0 transcript.                                        |

- Initial formatting artifacts: `.pi/structured-returns/6d1d07a6-8ae2-4e3e-965b-399136038184.stdout.log` and `.pi/structured-returns/75a92afd-0829-475a-afec-286584cc571f.stdout.log`.
- Both suite-load failures report `Cannot read properties of undefined (reading 'Object')`. Installed Pi 1.5.0's direct `pi-ai` export lacks `Type`; the host's legacy import shim is not present in this Vitest run.
- Types: `index.ts:3` imports missing `Type`; `render.ts:2` imports missing `TSchema`; `extension.test.ts:400` has a renderer-context fixture missing `durationMs`, `outputPad`, and `keyText`.
- These failures exist in unchanged base code with installed Pi 1.5.0 peers. No feature, fixture, import, dependency, or tooling fixes were made. The clean-baseline gate remains blocked pending coordinator direction.
- The `vitest-json` compact summary incorrectly omitted suite-load failures and said only `75 passed`. The saved JSON was checked separately for overall success and failed suites; do not treat that compact summary as a passing suite.

#### Instructions and references read

- Full input plan; repository/package READMEs and package scripts; package manual skill; root ESLint/Prettier config and package TypeScript scope; structured-return skill. No repository/package `AGENTS.md` or `CLAUDE.md` files were found. The supplied agent instructions remain applicable.
- Installed docs read in full under `/Users/roberthowley/.pi/pkg/pi-1.5.0/docs/`: `extensions.md`, `sdk.md`, `settings.md`, `configuration.md`, `security.md`, `tui.md`, `sessions.md`, `session-format.md`, and `message-types.md`.
- Installed examples read in full under the sibling `examples/`: `sdk/README.md`, SDK examples `01-minimal.ts` through `13-session-runtime.ts`, `extensions/README.md`, `project-trust.ts`, `auto-commit-on-exit.ts`, `structured-output.ts`, `shutdown-command.ts`, `reload-runtime.ts`, `qna.ts`, `summarize.ts`, and `tools.ts`.
- Read the additive rebuild wiki handoff and the pinned baseline research artifact identified in section 7. Retain all research artifacts; none were modified.

#### Regression files to retain unchanged in behavior

- `__tests__/extension.test.ts`: old finish payload, partial healthy-source finish/warnings, frozen paging/context, seed enrollment, cancellation/shutdown release, disabled behavior, and response limits.
- `__tests__/checkpoints.test.ts`: both finish overloads, legacy migrations/defaults, atomic rollback, process lock exclusion/enrollment/release.
- `__tests__/evidence.test.ts` and `__tests__/discovery.test.ts`: seed cutoff/defaults, branches/edits, unknown timestamps, frozen later appends, archive/identity failures.
- `__tests__/config.test.ts`: default enabled state and trusted-project/global precedence.
- `__tests__/limits.test.ts`, `__tests__/memory.test.ts`, `__tests__/render.test.ts`, and all existing fixtures: bounded reads/output/heap, provenance, partial states, and presentation safety.
- No existing test assertions were deleted, skipped, or weakened. No feature implementation, personal task/settings access, real-provider checks, push, or PR mutation occurred.

### Phase 0 repair and Phase 1 compatibility proof (2026-11-11)

#### Environment repair and clean-baseline gate

- Followed the read-only diagnosis at `/Users/roberthowley/.pi/subagent-runs/20261111T175233Z-7eler3kj/01-worker-hard.md`, after reading the phase-0 report at `/Users/roberthowley/.pi/subagent-runs/20261111T174556Z-h2zwbia0/result.md`.
- Replaced only the three ignored package-local `node_modules/@earendil-works/{pi-ai,pi-coding-agent,pi-tui}` links. They now use the existing lockfile-matched 0.84.4 installation under `/Users/roberthowley/src/github.com/pi-userland/node_modules/.pnpm/`. Root tooling link retained; no installation, manifest, lockfile, harness, or baseline-source changes.
- Base remains `f1ee2267ace546d1636048ee9468621fd8eb983e`, branch `remem-auto-v2`. Donor `d012f37a6fb7eabd3ee1d23587b54150b740317c` was not imported or modified.
- Reused isolation root `/tmp/pi-remembrancer-phase0.Nnrqpd`: HOME=`home`, XDG_STATE_HOME=`state`, XDG_CONFIG_HOME=`config`, PI_CODING_AGENT_DIR=`agent`, TASKRC=`taskrc`, TASKDATA=`taskdata` beneath it. Node is 24.22.1. Child probes inherit this isolation and use explicit temporary database paths.
- Every check used `structured_return` from this package directory, with the command scopes in section 5. Each command saves its real exit status as `TRUE_EXIT_STATUS` in the corresponding `.stderr.log` and exits with that status. The tables identify `.stdout.log` artifacts under `.pi/structured-returns/`.
- Independently inspected Vitest JSON, not just the compact parser: baseline `success: true`, 124/124 assertions passed, zero failed suites, and no suite-load error messages. This supersedes the blocked result under the incorrectly linked Pi 1.5.0 peers.

| Baseline check                  | Result (real exit status)                     | Stdout artifact                                   |
| ------------------------------- | --------------------------------------------- | ------------------------------------------------- |
| Full package tests              | 124 passed, zero failed assertions/suites (0) | `d8dd5646-203a-4635-971b-baa26c3fcf21.stdout.log` |
| Lint, script scope              | 17 files, zero errors/warnings (0)            | `ae323ebb-136b-4f56-9865-6999a14aedf1.stdout.log` |
| Types                           | Zero errors (0)                               | `54fd531e-3ccc-40ae-bb8a-2dbef9126f5c.stdout.log` |
| Formatting, expanded plan scope | Passed (0)                                    | `59229f0a-2b56-45e1-b669-8ad640b1f331.stdout.log` |

The clean-baseline gate passed before Phase 1 changes began.

#### Phase 1 changes and decisions

- Added six manual compatibility cases: absent/false/true `autoCapture`, each with complete and partial source scope. They assert the original schema/actions, old finish payload, non-TUI completion, unchanged response/details, unread-continuation rejection, exact text reconstruction, healthy-only checkpoint updates, and warnings with unavailable-source coverage unchanged.
- Each case advances fake timers by six minutes while waiting for manual approval. Coverage remains unchanged, a separate process remains excluded, enrollment from another process succeeds without releasing ownership, and the original owner can still finish and release.
- Added cancel and all five shutdown-reason cases (`quit`, `reload`, `new`, `resume`, `fork`): a separate process can claim after release, no coverage is saved, and the same evidence remains eligible after restart.
- Added separate-process ownership tests for explicit release and SIGKILL. A peer using `claimReview()` is excluded while ownership is live, can enroll without breaking that lock, then can claim and finish after release/death.
- New `__tests__/fixtures/review-lock-child.mjs` exercises the real baseline `CheckpointStore` in another Node process. It uses Node's `--experimental-strip-types` for the existing TypeScript source, supported by the declared Node floor. No model, Taskwarrior, personal configuration, or provider is loaded by the child.
- Retained every existing assertion and production export. Manual `Batch`, schema, errors, completion, store overloads, and process-lock implementation remain untouched. No lease, manual proposal argument/action, replacement review engine, TUI gate, capture implementation, or proposal storage was added.
- Deferred `review-pages.ts` extraction: there is still only one production consumer in this phase. Later phases may mechanically share paging/context when they add a second consumer; current limits and behavior remain byte-for-byte unchanged.
- Lock tests prove the shared process-lock contract that capture must use, not integration with a capture implementation that does not exist yet. The capture setting is only supplied as a compatibility input here; its parsing, precedence, and automatic behavior remain Phase 3 work.

#### References read by this worker before tracked edits

- This full plan and both phase-0 reports above; package scripts, current manual extension/store/config, and relevant original compatibility tests.
- Skills: `/Users/roberthowley/src/github.com/bauhaus-code/skills/bauhaus-code/SKILL.md`, `/Users/roberthowley/src/github.com/shopify-playground/de-robhowley/pi-tastes-good/skills/code-in-good-taste/SKILL.md`, and `/Users/roberthowley/src/github.com/pi-userland/packages/pi-structured-return/skills/structured-return/SKILL.md`.
- Full installed documentation under `/Users/roberthowley/.pi/pkg/pi-1.5.0/docs/`: `sdk.md`, `extensions.md`, and `settings.md`.
- Full installed examples under `/Users/roberthowley/.pi/pkg/pi-1.5.0/examples/`: `sdk/01-minimal.ts`, `sdk/06-extensions.ts`, `sdk/11-sessions.ts`, `extensions/shutdown-command.ts`, and `extensions/auto-commit-on-exit.ts`.
- Actual compatibility checked against linked 0.84.4 `pi-coding-agent/dist/core/extensions/types.d.ts`: `ExtensionContext`, `ToolDefinition`, render context, and session startup/shutdown declarations. Installed 1.5.0 documentation did not justify changing baseline code to a different SDK API.
- Read the additive rebuild wiki handoff in full. No donor implementation was needed for this test-only phase.

#### Phase 1 checks and gate

| Check                           | Result (real exit status)                                      | Stdout artifact                                   |
| ------------------------------- | -------------------------------------------------------------- | ------------------------------------------------- |
| Focused extension/store tests   | 57 passed, zero failed assertions/suites (0)                   | `c3cdb8df-0e3b-4351-b6bc-73778b0de3e7.stdout.log` |
| Full package tests              | 138 passed, zero failed assertions/suites (0)                  | `33927b46-84c4-41d9-bcf3-7f9794ccaad4.stdout.log` |
| Lint, script scope              | 18 files, zero errors/warnings (0)                             | `2100295a-0961-437f-ad09-2b3feb9c5195.stdout.log` |
| Types                           | Zero errors (0)                                                | `8e6f9de3-0550-4b33-a0f8-4a2ccd61cb16.stdout.log` |
| Formatting, script scope        | Passed (0)                                                     | `c7c4c20c-d209-4da4-afb7-dad4c38ed4ff.stdout.log` |
| Formatting, expanded plan scope | Passed before execution-record append (0); rechecked afterward | `9760a1a1-fd66-4cc3-b1e5-6b2e48828c5f.stdout.log` |

- Full and focused Vitest JSON independently checked for `success: true`, assertion counts, failed-suite counts and suite-load messages. No suite errors were hidden by the parser.
- Initial development check failed with 14 new test failures (43 passed) because the child imported optional IPC methods as named `node:process` exports; three new fixture-schema type errors also appeared. Corrected the child to use the default process object and typed the test schema shape. No production fixes or existing assertion changes were needed. Failed-test artifact: `31aa6629-a2d2-4e65-9e70-170d2088ddbe.stdout.log`; initial type artifact: `ac0883c6-1f89-4bd3-89d0-0437e5f003b0.stdout.log`.
- Phase 1 gate passed on the locked SDK tree. Scope/whitespace and final plan formatting are checked before the local commit. No personal task/config changes, real-provider/live-TUI checks, push, PR changes, or phases 2–5 work occurred.

### Phase 2: proposal persistence and capture-only completion (2026-11-11)

#### Scope and donor inspection

- Started from Phase 1 commit `a6cb34ac7397c3cbc06820f630dde4f647dffe66`; original base and pinned donor remain unchanged.
- Read this full plan, `/Users/roberthowley/.pi/subagent-runs/20261111T175515Z-sbnfwmh6/result.md`, the additive rebuild wiki handoff, current production/store/evidence code, package scripts and relevant tests before implementation.
- Read the same three code/structured-return skills listed in Phase 1. Read full installed `docs/sdk.md`, `docs/extensions.md`, `docs/sessions.md`, `docs/session-format.md`, `docs/message-types.md` and `examples/sdk/01-minimal.ts`, `examples/sdk/11-sessions.ts`, `examples/extensions/structured-output.ts` under `/Users/roberthowley/.pi/pkg/pi-1.5.0/`. Runtime peers remain locked 0.84.4; no SDK session/lifecycle integration was added.
- Inspected donor additions/differences for `proposals.ts`, `checkpoints.ts`, `review.ts` and `proposals.test.ts`. Reused proposal types/schema/validators, proposal persistence/history/claim/outcome methods, submission persistence and relevant tests. Adapted the schema import to the locked host's `pi-ai` Type export.
- Rejected donor leases, manual review replacement and donor manual finish changes. Extracted paging/context from the current base, not the donor. No cherry-pick, dependency, manifest, lockfile, harness, configuration, unrelated-package or phases 3–5 changes.

#### APIs and behavior

- `CheckpointStore` retains both manual `finish` overloads and the existing `.lock` ownership protocol. `releaseReview` additionally forgets the in-memory capture; no ownership expiry or database lease was added.
- Proposal reads: `proposals(state?, offset?, limit?)`, `proposalCount(state?)`, `proposal(id)`. Decisions: `editProposal`, `dismissProposal`, `claimProposal`, `recordProposalResult`, all guarded by revisions; claims and outcomes remain durable and cannot be blindly replayed.
- Capture caller sequence: `claimReview()` → `prepareCapture({ sessionId, file })` → `CaptureReview.page()`/`context()` → `validateCapture(id, submissions)` for staging → `finishCapture(id, submissions)` after reviewer cleanup/deadline checks → `releaseReview()` in `finally`. Phase 3 owns reviewer staging, deadlines and cleanup; none run in this phase.
- `CaptureReview` exposes `id`, `hasEvidence`, `incomplete`, copied `warnings`, bounded evidence paging and frozen context. Preparation reads only the selected source, using stored checkpoint/default eligibility. The plan, evidence and delivery cursor stay private; callers cannot submit a coverage plan or mark evidence delivered.
- Capture completion requires complete source scope, every evidence continuation and an explicit proposal array. Exact quotes, UTF-16 offsets, branch/edit identity and proposal revisions are validated; supporting context cannot create extraction scope. Empty/tool-only/already-covered evidence cannot commit source or coverage changes.
- A private normalized coverage writer is shared by manual and capture completion. One transaction owner commits proposals and coverage together, rechecking revisions under `BEGIN IMMEDIATE`; failures leave the capture available until the caller releases it. Successful completion invalidates its identity but keeps process ownership until explicit release.
- `review-pages.ts` mechanically shares the original paging/serialization/context functions. `index.ts` only imports/re-exports those helpers; manual `Batch`, schema/actions, handlers, completion semantics, output shape and limits remain unchanged.
- Added 31 cases for atomic success/rollback, malformed references/scopes, unread continuations, exact edited selections, stale/duplicate revisions, context exclusion, late appends/edits, seed defaults, empty evidence, ownership, private files, unknown tables, restart/history/drafts/decisions/claims/outcomes and manual/proposal separation.
- Existing process-lock fixture now registers a test-only TypeScript loader because runtime store imports use emitted `.js` specifiers and constructor parameter properties. It uses existing root TypeScript tooling, preserves all probe actions/assertions and changes no runner configuration or production imports.

#### Checks and gate

- Isolation root: `/tmp/pi-remembrancer-phase2`, with HOME=`home`, XDG_STATE_HOME=`state`, XDG_CONFIG_HOME=`config`, PI_CODING_AGENT_DIR=`agent`, TASKRC=`taskrc`, TASKDATA=`taskdata`. No personal tasks/settings or providers were accessed.
- Checks used `structured_return`, the section-5 commands/parsers and true exit-status recording. Artifacts below are `.stdout.log` names under package-local `.pi/structured-returns/`; matching `.stderr.log` files contain `TRUE_EXIT_STATUS`.

| Check                           | Result (real exit status)                     | Stdout artifact                                   |
| ------------------------------- | --------------------------------------------- | ------------------------------------------------- |
| Focused proposal/store tests    | 39 passed, zero failed assertions/suites (0)  | `f7ba8552-f5aa-4b09-8f40-fc4dcbcd1360.stdout.log` |
| Full package tests              | 169 passed, zero failed assertions/suites (0) | `f9178396-1840-478b-ae25-4fb0db280c55.stdout.log` |
| Lint                            | 23 files, zero errors/warnings (0)            | `236f577f-3902-4a61-89a0-7aa343da9206.stdout.log` |
| Types                           | Zero errors (0)                               | `46a3cd93-a35e-4bba-9fbd-8d9d8f0c4372.stdout.log` |
| Formatting, expanded plan scope | Passed (0), rechecked after this record       | `24df6579-12d0-49b8-b218-b8c32445b7b6.stdout.log` |

- Independently inspected full Vitest JSON: `success: true`, zero failed assertions/suites, no suite-load messages. Compared test-name/status multisets to Phase 1: all 138 cases retained and passing, 31 added, none missing. No original test assertions were changed.
- Initial development checks exposed the child import-resolution issue, one exact-optional fixture type error and two missing `URL` imports in the new loader. Fixed only new code/fixture setup; no baseline assertions were removed or weakened. Initial artifacts: tests `36946107-c326-46c7-98fc-924f764eba04.stdout.log`, types `564bc25b-7336-4315-97bc-cb1cd028f3f6.stdout.log`, lint `ed3caf25-d6bb-4258-a278-d4dd9ed1462b.stdout.log`.
- Phase 2 gate passed. Final whitespace/scope and post-record formatting checks precede the local commit. Capture invocation, isolated reviewer, settings, Taskwarrior application, proposal UI and live-provider/live-TUI validation remain outside this phase. No push or PR mutation.

### Phase 3: isolated reviewer and opt-in shutdown capture (2026-11-11)

#### Scope and implementation

- Started from Phase 2 commit `248150ef457de5dee36ebfa101cb84750359dd0a` on `remem-auto-v2`; original base and pinned donor remain unchanged.
- Read this plan, the Phase 2 report, additive rebuild wiki handoff and code/structured-return skills. Inspected installed SDK, resource-loader, extension/tool/lifecycle, settings and session-manager declarations/implementations against the linked 0.84.4 runtime. Read installed SDK/extensions/session/settings/configuration/message-format documentation and the SDK model/tool/resource/session/full-control and shutdown/structured-output examples.
- Inspected each donor diff for `reviewer.ts`, `capture.ts`, `config.ts`, the read-only `taskwarrior.ts` subset and shutdown wiring, plus donor reviewer/capture/SDK tests. No cherry-pick, donor lease/manual engine, proposal UI, task-application code, manifests, lockfiles, dependencies or harness changes.
- Added `autoCapture: false` independently of `disabled: false`, preserving per-field trusted-project/global precedence. Capture rereads both settings at outgoing shutdown; effective disabled wins. Manual registration/schema/actions/exports/partial finish and non-TUI completion remain unchanged.
- Shutdown measures its budget at handler entry, releases any abandoned manual batch without coverage, awaits outgoing capture, then closes the database in `finally`. Capture skips non-TUI/unknown modes, unsaved sessions and absent/false/disabled settings.
- Capture claims the existing `.lock` before `prepareCapture`, reads only the outgoing source and uses its frozen eligibility/defaults. It holds ownership through reviewer cleanup, deadline validation and atomic `finishCapture`, releasing in `finally`. Busy ownership reports failure without retry or takeover. Empty/tool-only/covered evidence calls no reviewer and saves no capture source/coverage changes.
- Ported the temporary in-memory SDK reviewer with only five fixed tools: frozen evidence, frozen supporting context, fixed read-only task exports, stored proposals and submission. No extensions, skills, AGENTS/context files, prompt files, parent transcript, fallback, retry or compaction. Normal provider/auth startup and the outgoing selected model are retained.
- Submissions require an explicit array, complete evidence delivery and exact provenance validation, once and alone in the tool batch. Results remain staged until normal reviewer completion, awaited cleanup and a final deadline check. Failure saves neither proposals nor coverage and reports the outgoing session ID; a throwing notifier still releases ownership and closes the shutdown database.
- Added explicit provider retry suppression, rejection of length-truncated assistant output, cancellation after prompt failure, and awaited disposal/abort settlement through cleanup. Cancellation remains active during cleanup; deadline expiry cannot permit late commit or ownership replacement. Cleanup may remain unbounded.

#### Checks and gate

- Isolation root: `/tmp/pi-remembrancer-phase3`, with HOME=`home`, XDG_STATE_HOME=`state`, XDG_CONFIG_HOME=`config`, PI_CODING_AGENT_DIR=`agent`, TASKRC=`taskrc`, TASKDATA=`taskdata`. Tests use temporary transcript/database/config paths and fake task executors. No personal tasks/settings, real credentials or external provider requests were used.
- All checks used `structured_return` and the section-5 scopes/flags. Each verification command recorded its real exit status as `TRUE_EXIT_STATUS` in its `.stderr.log`. The table lists `.stdout.log` names under package-local `.pi/structured-returns/`.

| Check                           | Result (real exit status)                     | Stdout artifact                                   |
| ------------------------------- | --------------------------------------------- | ------------------------------------------------- |
| Full package tests              | 279 passed, zero failed assertions/suites (0) | `650b2456-3203-4df7-802f-63468dd7a694.stdout.log` |
| Lint                            | 30 files, zero errors/warnings (0)            | `34cdc2b2-8080-425a-84f2-4ead0b423c90.stdout.log` |
| Types                           | Zero errors (0)                               | `aec59796-dbb4-461a-9db2-4e2409921dab.stdout.log` |
| Formatting, expanded plan scope | Passed (0), rechecked after this record       | `a27517be-8acf-4e0c-b594-c053cb19c14d.stdout.log` |

- Independently parsed actual Vitest JSON: `success: true`, zero failed assertions/suites and no suite-load messages. All 169 Phase 2 test-name/status occurrences remain present and passing; 110 cases were added. Focused reviewer/capture/SDK/config/lookup checks passed 125 cases before the final full run.
- Nine deterministic localhost SDK cases exercised the actual locked runtime: explicit empty/nonempty success, mixed/duplicate/unread/missing submissions, truncated output, invalid task lookup and provider error without retry. They assert the exact tool surface, selected model, absence of resource sentinels and parent transcript preload, outgoing transcript byte preservation, and no data/coverage on failure. Only a synthetic localhost authentication value is configured.
- Other added cases cover settings reread/precedence, pre-opt-in evidence, source-only eligibility, empty evidence, long continuations, frozen appends/edits, staging/cleanup/storage failures, deadline cancellation/ownership, throwing notifiers, manual abandonment, automatic/manual coverage sharing and pending proposals surviving non-TUI manual finish with capture off.
- Initial development checks exposed necessary 0.84.4 schema/tool-field type adaptations (`391c2f78-0ea9-4ef2-8ada-86dd1e739654.stdout.log`), one new fixture that omitted manual source enrollment (`4d93bffc-66d2-42de-9ed3-96790b11752d.stdout.log`) and an unsafe-finally lint finding in new cleanup code (`67118d71-6764-474e-a50e-f8e25d99543c.stdout.log`). Corrected new implementation/fixtures; no original assertion was removed or weakened. The existing default-config assertion now includes the additive false flag.
- Phase 3 gate passed. Final whitespace/scope and post-record formatting checks precede the local commit. Live-provider/live-TUI behavior and recognition quality were not tested; cleanup is intentionally not time-bounded. No push or PR mutation.

#### Phase 4 handoff

- New entry point: `captureOutgoing(ctx, store, deadline)` and `CAPTURE_BUDGET_MS`; shutdown owns database lifetime. `ReviewerInput`/`runReviewer` own isolated SDK setup, cancellation and cleanup, not persistence.
- `RemembrancerConfig` adds `autoCapture`; manual registration stays independent. `taskwarrior.ts` currently contains only `TaskRecord`, `TaskExecutor`, `executeTask` and `lookupTasks` for fixed read-only exports; phase 4 may add verified application/UI functions against the unchanged Phase 2 proposal store APIs.
- No changes were needed to `capture-review.ts`, `checkpoints.ts`, proposal schemas or shared paging APIs. Proposal command/completions/startup reminder/application and user-facing documentation remain phases 4–5 work.

### Phase 4: model-free proposal UI and verified application (2026-11-11)

#### Scope and implementation

- Started from Phase 3 commit `123084d5550a6dc0a2e8cc1b1132a2eb3b47d205` in the managed implementation worktree. Original base `f1ee2267ace546d1636048ee9468621fd8eb983e` and pinned donor `d012f37a6fb7eabd3ee1d23587b54150b740317c` remain unchanged. Changes are left uncommitted for managed patch capture.
- Read the full plan, Phase 3 report, package manual skill and code/structured-return skills. Read installed `docs/extensions.md`, `docs/tui.md`, `docs/sdk.md`, `docs/keybindings.md` and the full custom-UI/tools/minimal-SDK examples. Checked runtime behavior against the ignored, lockfile-matched 0.84.4 peer links; no dependency installation, manifest, lockfile, harness or unrelated-package changes.
- Inspected donor per-file diffs for `taskwarrior.ts`, `proposal-ui.ts`, `index.ts`, `taskwarrior.test.ts` and proposal-related extension tests. Ported application/UI functions and relevant assertions, adapting fixtures to real `prepareCapture`/`finishCapture` and the existing shared pager. Did not cherry-pick or import donor manual-finish, lease or manual-proposal-action changes.
- Added `requireTui`, `snapshot`, `TaskPreview`, `previewProposal`, `satisfies`, `writeTaskChange`, `applyProposal` and `resolveProposal`. Fixed read-only lookup behavior remains unchanged. Application rechecks the displayed proposal revision and full actual task, claims durably before typed JSON import, exports the exact UUID, verifies the actual result and records its outcome.
- Unresolved questions prevent claims/writes. A stale task or proposal requires a refreshed preview and another deliberate approval. Import/export errors remain uncertain even if an actual result is present; failed local outcome persistence leaves the durable applying claim. Neither state can replay a write. Explicit resolution only reads and records an already-present matching result; otherwise it directs manual resolution.
- Added the model-free `/remembrancer proposals` command, parsing/completions and TUI startup pending-count reminder independently of capture absent/false/true. Disabled settings suppress UI/reminder without deleting data. Startup reads the database count only for the reminder, with no proposal-body load, source/archive read, Taskwarrior execution or model access.
- The UI shows exact field/status/annotation changes, actual target record, explanation and saved quotes. Edit saves a revisioned draft, Dismiss changes one item, and History exposes saved proposals/drafts/revisions without external reads. Only per-item Ctrl+A from the preview applies or explicitly verifies an unresolved claim; Enter, other views, navigation, editing, dismissal and close cannot write tasks. There is no accept-all. JSON display escapes both C0 and C1 terminal controls reversibly in previews, Source, History and draft-editor input.
- Source lazily reads only referenced files on the saved branch, validates session/branch/entry/edit/role/time/offset/quote, and uses the shared 50 KiB/48,000-text-unit/200-entry pager for up to two surrounding messages each side. Saved quotes and identifiers survive missing, corrupt, stale, unreadable and over-limit files. Preview/navigation/history never load source files or scan archives.
- Existing manual schema/actions/defaults/non-TUI completion, partial healthy-source finish, process ownership and exports remain unchanged. Pending proposals are a separate queue, not replayed by manual review or changed by ordinary finish. A coexistence case retains pending/dismissed/applying decisions through an old-payload, non-TUI partial manual finish with capture off.
- No storage/pager adjustments were needed. `README.md` and `skills/remembrancer/SKILL.md` are untouched and remain assigned to the independent documentation worker.

#### Checks and gate

- Isolation root: `/tmp/pi-remembrancer-phase4`, with HOME=`home`, XDG_STATE_HOME=`state`, XDG_CONFIG_HOME=`config`, PI_CODING_AGENT_DIR=`agent`, TASKRC=`taskrc`, TASKDATA=`taskdata`. Tests use temporary databases/transcripts, fake terminal/model/Taskwarrior effects and the donor's explicitly isolated Taskwarrior CLI fixture. No personal task/config/provider access occurred.
- All commands used `structured_return` with the section-5 scopes/parsers and recorded real exit status as `TRUE_EXIT_STATUS` in corresponding `.stderr.log` files. Artifacts below are `.stdout.log` names under package-local `.pi/structured-returns/`.

| Check                            | Result (real exit status)                 | Stdout artifact                                   |
| -------------------------------- | ----------------------------------------- | ------------------------------------------------- |
| Focused UI/application/extension | 76 passed, zero failed/skipped cases (0)  | `e53365f0-8610-4e3d-a5c9-553f857ce9d1.stdout.log` |
| Full package tests               | 342 passed, zero failed/skipped cases (0) | `751a4fa3-4b27-4577-98b1-d47c5a51525b.stdout.log` |
| Lint                             | 33 files, zero errors/warnings (0)        | `0a592e48-5a45-4e22-9ed2-3d2bb27b7601.stdout.log` |
| Types                            | Zero errors (0)                           | `95c3c4c1-70b9-4026-8a57-c9631936e9bf.stdout.log` |
| Formatting, expanded plan scope  | Passed (0), rechecked after this record   | `bcb58eed-494c-4f99-a894-14728c7515d7.stdout.log` |

- Independently parsed actual Vitest JSON: `success: true`, 342/342 passed, zero failed suites, zero skipped cases and no suite-load messages. Compared test-file/name/status multisets against Phase 3 artifact `650b2456-3203-4df7-802f-63468dd7a694`: all 279 prior cases retained/passing, none missing, 63 added. Existing assertions were not removed or weakened; the old exact completion array was extended with the new proposal subcommand.
- Added/ported 51 application/UI cases and 12 proposal-extension cases. They cover typed literals, actual-record verification, concurrent SQLite claims, stale approval, questions, missing targets, failed/uncertain outcomes, read-only resolution, Source bounds/provenance/failures, drafts/history/dismiss-one, non-writing keys/views, startup-only count, settings independence and manual-queue separation. The isolated installed Taskwarrior import/export case passed, not skipped. Existing nine deterministic localhost SDK cases still pass.
- Initial development checks found the expected additive completion-array mismatch (`0629a323-56d7-428d-add4-66310237de65`), two new-fixture assumptions about allowed UI task reads/undefined mode (`dd22ea17-0cba-4d64-9678-3c21c4a29798`) and new-fixture mode typing (`509640ca-2475-406f-9929-2f991dd26d4d`). Corrected fixtures/assertions without changing manual behavior or weakening existing checks.
- Phase 4 implementation gate passed on the locked runtime. Final post-record formatting and whitespace/scope checks follow. No live-provider/live-terminal smoke test, obligation-recognition assessment, independent review, publication or PR mutation was performed. Taskwarrior/SQLite remain separate transactions; external edits can race the final pre-write check, and semantic duplicates created elsewhere are not guaranteed to be detected.

### Phase 4/UI and additive documentation integration (2026-11-11)

- Confirmed clean `remem-auto-v2` at `123084d5550a6dc0a2e8cc1b1132a2eb3b47d205`, read the full plan and both worker reports, then checked/applied `worktree-0.patch` and `worktree-1.patch` from `/Users/roberthowley/.pi/subagent-runs/20261111T183412Z-kztoj46t/`. Only package files were imported; existing ignored 0.84.4 peer links were retained without dependency changes.
- Compared README/skill with original base `f1ee2267ace546d1636048ee9468621fd8eb983e`: every original line remains in order. Checked added settings, paths, shutdown lifecycle, lazy Source, approval and unresolved-write instructions against implementation. Small README reconciliation names pending JSON drafts, History/Source toggles, Esc behavior and read-only unresolved Ctrl+A resolution. No product changes or manual-instruction replacement.
- Full section-5 commands ran through `structured_return` under `env -i`, retaining PATH only and setting HOME/XDG_STATE_HOME/XDG_CONFIG_HOME/PI_CODING_AGENT_DIR/TASKRC/TASKDATA beneath `/tmp/pi-remembrancer-integration-20261111`. No inherited provider credentials, personal tasks/configuration or live providers were used. SDK tests use deterministic localhost transport; Taskwarrior tests use fake executors or isolated CLI storage.
- Full tests: 342/342 passed; independently parsed JSON `success: true`, 17 suites, zero failed suites/assertions, zero pending tests and no suite-load messages. All 279 Phase 3 passing test names remain present. Artifact: package-local `.pi/structured-returns/6add4b11-3ca7-44fc-b6eb-9a1eec8e898f.stdout.log`.
- Lint: 33 files, zero errors/warnings (`f677b34f-a071-4587-904d-1f89f8bcf762.stdout.log`). Types: zero errors (`520ef190-773f-4e14-ad89-2e903ff77325.stdout.log`). Expanded formatting: passed (`dc597f4f-b635-48ac-acc9-210c11356a83.stdout.log`). These artifacts are package-local `.pi/structured-returns/`; matching stderr logs each record `TRUE_EXIT_STATUS=0`.
- Whitespace/base diff/working-tree scope passed through `structured_return`, artifact root `.pi/structured-returns/6981b0db-b167-42da-8845-84d0df0e47dd.combined.log`. An initial scope assertion incorrectly expected root-relative paths while run inside the package; rerunning from the repository root passed without file changes. Final formatting and staged scope/whitespace checks follow this append before commit.
- Independent verification follows this integration. No live-provider/live-terminal quality claim, push, PR or donor mutation. External task-edit races, unbounded cancellation cleanup and semantic duplicate limitations remain as documented.

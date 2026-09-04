# pi-merge-ready

Know if your GitHub pull request is ready to merge, what’s blocking it, and let Pi fix what it can.

GitHub works out of the box. Other source-control hosts require a provider registered by another Pi extension.

`pi-merge-ready` keeps current-branch status visible and inspects full pull request URLs. It can wait on checks and review, then queue one bounded agent repair attempt for failing CI, merge conflicts, or an out-of-date branch.

## Install

```bash
pi install npm:@robhowley/pi-merge-ready
```

The built-in GitHub provider requires `git` and an authenticated GitHub CLI (`gh`) on Pi's `PATH`.

## Quick start

| Goal                           | Command                                                           |
| ------------------------------ | ----------------------------------------------------------------- |
| Check the current branch PR    | `/merge-ready`                                                    |
| Check another PR               | `/merge-ready --url https://github.com/OWNER/REPO/pull/64`        |
| Return machine-readable status | `/merge-ready --url https://github.com/OWNER/REPO/pull/64 --json` |
| Wait and repair when possible  | `/merge-ready watch`                                              |
| Watch another PR               | `/merge-ready watch --url https://github.com/OWNER/REPO/pull/64`  |

The command lists everything that needs action, waiting, or verification. If the package cannot tell whether a PR is blocked, it reports an ambiguous status instead of reporting the PR as ready.

## See PR status

### Status bar and cmux

The Pi status bar shows the current branch PR number and its top readiness state:

```text
✅ #64 Ready
👀 #64 Review pending
❌ #64 Checks failing
🔄 #64 Out of date
❌ #64 💬 2 unresolved
❔ No PR
```

`✅ #64 Ready` means an open PR has no merge-readiness blockers. Optional unresolved conversations can still appear as context without blocking readiness:

```text
✅ #64 Mergeable · 💬 2 comments
```

When Pi runs in a cmux TUI workspace outside CI, the same current-branch status appears in the workspace sidebar:

<img src="https://raw.githubusercontent.com/robhowley/pi-userland/main/packages/pi-merge-ready/img/cmux-pr-status.png" alt="cmux workspace sidebar showing Pi thinking and PR #173 mergeable with one comment" width="422">

For GitHub PRs, `PR #N` links to the pull request URL returned by its provider. cmux publishing is enabled by default when available. Set `pi-merge-ready.cmux.enabled` to `false`, then reload Pi to hide it.

### cmux notifications

For GitHub PRs, cmux sends a notification when the current-branch PR has an actionable merge-readiness change:

| From    | To              |
| ------- | --------------- |
| Ready   | Action required |
| Waiting | Ready           |
| Waiting | Action required |
| Blocked | Ready           |

Action required means merge conflicts, an out-of-date branch, a generic merge block, failing checks, or changes requested. Each notification body starts with `owner/repo PR #N` so the PR remains identifiable in cmux's Notifications panel.

### `/merge-ready`

Inspect the current branch PR:

```bash
/merge-ready
```

Or target one full pull request URL:

```bash
/merge-ready --url https://github.com/OWNER/REPO/pull/64
/merge-ready --url https://github.com/OWNER/REPO/pull/64 --json
```

Example:

```text
⏳ Checks are still running
Target: current branch feat/my-branch (owner/repo)
PR: #64 — Add PR merge-readiness extension
State: pending
Open items:
- Checks are still running
```

Full pull request URLs are accepted. GitHub URLs remain supported by default. Detail URLs support a returned blocker; they are not separate action items.

## Keep a PR moving

Start a foreground watcher for the current branch or one full PR URL:

```bash
/merge-ready watch
/merge-ready watch --url https://github.com/OWNER/REPO/pull/64
/merge-ready watch --url https://github.com/OWNER/REPO/pull/64 --interval 30
```

In the TUI, press `Ctrl-Shift-S` to stop it. In a headless SDK session, abort or dispose the backing session.

- **Repair once:** queue one bounded agent repair attempt for `branch_out_of_date`, `merge_conflicts`, or `ci_failing`.
- **Keep polling:** wait on `ci_running`, `review_pending`, or an open PR with no blockers.
- **Stop and report:** stop for `changes_requested`, `unresolved_conversations`, `merge_blocked`, `draft`, `status_ambiguous`, `no_pull_request`, or a closed or merged PR.

Current-branch repairs use the current checkout. They refuse to start with a dirty worktree.

The handoff instructs the repair agent to use an isolated worktree for the PR head repository and branch and not mutate the current checkout.

After attempting a blocker, the watcher does not retry it until the status changes or the watcher is restarted. Matching `repairGuidance` from settings is included in the repair handoff.

## Agent integration

Agents receive a `merge_ready_status` tool:

```ts
merge_ready_status({});
merge_ready_status({ url: 'https://github.com/OWNER/REPO/pull/64' });
```

The contract is small:

- `state` and `pr.lifecycle` describe the overall result
- `openItems` is the only authoritative blocker list
- `openItems[].details[]` and their URLs are supporting context
- targets are either the current branch or one full pull request URL
- branch names, PR numbers, repo names, and inferred targets are not accepted

Example response:

```json
{
  "state": "blocked",
  "target": {
    "mode": "current_branch",
    "owner": "owner",
    "repo": "repo",
    "branch": "feat/my-branch"
  },
  "pr": {
    "lifecycle": "open",
    "number": 64,
    "title": "...",
    "url": "...",
    "headRefName": "feat/my-branch",
    "baseRefName": "main"
  },
  "summary": "Required checks are failing",
  "openItems": [
    {
      "id": "ci_failing",
      "summary": "Required checks are failing",
      "details": [
        {
          "label": "lint",
          "status": "failing",
          "url": "https://github.com/OWNER/REPO/actions/runs/123/jobs/456"
        }
      ]
    }
  ],
  "generatedAt": "2026-05-27T00:00:00.000Z"
}
```

The included `merge-ready-loop` skill handles requests such as "make this PR ready to merge." It works one returned blocker at a time, verifies local changes, and distinguishes local fixes from blockers source control has confirmed as cleared.

## Configuration

Configure the package in Pi's `settings.json`:

- global: `~/.pi/agent/settings.json`
- project: `.pi/settings.json` in a trusted project

```json
{
  "pi-merge-ready": {
    "autoCompactRepair": true,
    "cacheTTLSeconds": 60,
    "enableStatusBarDiagnostics": false,
    "cmux": {
      "enabled": true
    },
    "repairGuidance": {
      "ci_failing": "Start with the focused package test.",
      "merge_conflicts": "Rebase onto main before changing unrelated files."
    }
  }
}
```

| Option                       | Default | Description                                                                       |
| ---------------------------- | ------- | --------------------------------------------------------------------------------- |
| `autoCompactRepair`          | `true`  | Compact the conversation after a successful repair turn before polling resumes.   |
| `cacheTTLSeconds`            | `60`    | Cache the current-branch status bar result for this many seconds.                 |
| `enableStatusBarDiagnostics` | `false` | Write status refresh diagnostics as JSONL.                                        |
| `cmux.enabled`               | `true`  | Publish status and notifications when Pi runs in a cmux TUI workspace outside CI. |
| `repairGuidance`             | `{}`    | Add blocker-specific instructions to repair handoffs.                             |

`repairGuidance` accepts only `branch_out_of_date`, `merge_conflicts`, and `ci_failing`. Current-branch repairs combine global and trusted-project guidance. URL-targeted repairs use global guidance only.

When diagnostics are enabled, Pi writes `~/.pi/merge-ready/status-bar-debug.jsonl`. `PI_MERGE_READY_DEBUG_DIR` overrides the directory for the current process.

## Advanced

### Add a source-control provider

Use the provider API only to add a source-control host that the built-in GitHub provider does not handle. A provider identifies a target and reads pull request facts and signals. It does not decide whether the pull request is ready.

#### Implement and register

Import the public API from `@robhowley/pi-merge-ready/provider-api`. Use `defineMergeReadyProvider` to apply the public TypeScript contract to the provider object. Then call `registerMergeReadyProvider` to make it available to `pi-merge-ready`.

This example shows the contract, not a real service integration. In particular, replace the named current-branch placeholder with a lookup against your source-control host.

```ts
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import {
  defineMergeReadyProvider,
  registerMergeReadyProvider,
} from '@robhowley/pi-merge-ready/provider-api';

const EXAMPLE_CURRENT_BRANCH_CHANGE_NUMBER = 7; // Replace with a real host lookup.

const provider = defineMergeReadyProvider({
  id: 'example-scm',
  matchUrl(url: URL) {
    const match = url.pathname.match(/^\/([^/]+)\/([^/]+)\/changes\/([1-9]\d*)$/u);
    if (url.origin !== 'https://code.example' || !match) return null;
    const [, owner, repo, number] = match;
    return {
      url: `https://code.example/${owner}/${repo}/changes/${number}`,
      owner: owner!,
      repo: repo!,
      prNumber: Number(number),
    };
  },
  matchRemote({ url }) {
    const match = url.match(/code\.example[/:]([^/]+)\/([^/.]+)(?:\.git)?$/u);
    return match ? { owner: match[1]!, repo: match[2]! } : null;
  },
  async read(input) {
    const repository = input.mode === 'url' ? input.target : input.repository;
    const number =
      input.mode === 'url' ? input.target.prNumber : EXAMPLE_CURRENT_BRANCH_CHANGE_NUMBER;
    const url = `https://code.example/${repository.owner}/${repository.repo}/changes/${number}`;
    return {
      kind: 'found',
      pullRequest: {
        lifecycle: 'open',
        number,
        title: 'Example change',
        url,
        headRefName: 'feature',
        baseRefName: 'main',
      },
      signals: {
        draft: false,
        mergeability: 'mergeable',
        checks: 'passing',
        review: 'approved',
        unresolvedConversations: false,
        unresolvedConversationRequirement: 'optional',
      },
    } as const;
  },
});

export default function (pi: ExtensionAPI) {
  registerMergeReadyProvider(pi, provider);
}
```

Importing the API exports the types and helpers; it does not register the provider object. The extension must call `registerMergeReadyProvider` as shown.

#### Load and test

A separate local extension needs its own dependency installation so the API import resolves. Put a `package.json` beside the extension or in a parent directory, add `@robhowley/pi-merge-ready` to `dependencies`, and run `npm install` there.

Test the extension for one Pi run:

```bash
pi -e ./path/to/example-scm.ts
```

For persistent loading:

- put the extension in `~/.pi/agent/extensions/` for all projects
- put it in `.pi/extensions/` for a trusted project
- or add its file or directory path to the `extensions` array in the appropriate `settings.json`

A distributed Pi package must include `@robhowley/pi-merge-ready` in both `dependencies` and `bundledDependencies`. Separately installed Pi packages do not share module roots.

Providers are collected when a session starts. After changing a persistently loaded extension, `/reload` creates a refreshed extension runtime and starts the session again, which registers and collects the updated provider.

#### Provider methods

| Method        | Purpose                                                          | Return                               |
| ------------- | ---------------------------------------------------------------- | ------------------------------------ |
| `matchUrl`    | Recognize a full PR URL and normalize its repository and number. | URL target fields, or `null`.        |
| `matchRemote` | Recognize a Git remote for current-branch lookup.                | Repository fields, or `null`.        |
| `read`        | Read the matched PR from the documented ambient or URL input.    | `found`, `absent`, or `unavailable`. |

Check behavior differs by provider:

- **Generic contract:** report checks as `passing`, `failing`, `running`, or `unknown`. Each host decides how to obtain that answer.
- **Built-in GitHub provider:** query required checks. When GitHub reports no required checks, failed or unknown optional rollup checks do not block readiness. Running rollup checks keep the status pending.

#### Result kinds

| Result                | What to return                                                                                                   |
| --------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Open `found`          | PR identity and lifecycle, required `signals`, and optional supporting `evidence` and ordered `issues` messages. |
| Closed/merged `found` | PR identity and lifecycle, with optional source `signals`. Do not return `evidence` or `issues`.                 |
| `absent`              | No PR exists for the target.                                                                                     |
| `unavailable`         | A non-empty message and whether PR presence is `known` or `unknown`.                                             |

Issue messages add supporting details to `status_ambiguous`; they do not hide a concrete blocker reported by the signals.

#### Operational constraints

- Provider objects and results cannot supply `state`, `summary`, or `openItems`; `pi-merge-ready` owns those fields.
- Provider IDs must be unique, and `github` is reserved for the built-in provider.
- Every provider's URL or remote matcher runs once for a lookup. More than one matching provider is an error; there is no first-match fallback.
- Ambient reads receive `{ mode: 'ambient', remote, repository, cwd?, timeoutMs }`; URL reads receive `{ mode: 'url', target, cwd?, timeoutMs }`. Reads are capped at 20 seconds.
- Open results require signals. Closed and merged results may omit them.
- Fields that `pi-merge-ready` consumes are strictly validated: matches, PR identity and lifecycle, signals, evidence, and issues. Unrelated extra fields are ignored.
- Matcher exceptions, malformed matches or results, read failures, and timeouts fail explicitly.

### Experimental watch UI

The local watch UI can run several exact GitHub pull request URL watches:

```bash
/merge-ready watch-ui
/merge-ready watch-ui stop
```

After a successful launch, it opens a browser when possible and reports a token-gated localhost URL. It supports stop, restart, remove, and read-only transcript inspection. If its supervisor restarts, previously active watches appear as stale rather than ready.

### Target and lifecycle details

- Closed and merged PRs remain valid exact-URL targets and report their lifecycle.
- The built-in GitHub provider includes `pr.headRepository` in URL-targeted results. Custom providers should return it for URL repairs; the repair prompt instructs the agent to stop if editable head identity is missing.
- URL-targeted command results do not replace the current-branch status bar cache.
- Required unresolved conversations block readiness; optional conversations remain context only.
- An unresolved conversation with an unknown requirement produces `status_ambiguous`.
- A generic `merge_blocked` item is omitted when a more specific blocker already explains the state.

## Reference

### Status states

| State     | Meaning                                                         |
| --------- | --------------------------------------------------------------- |
| `ready`   | An open PR exists and no merge-readiness open items were found. |
| `blocked` | A blocker requires action before merge.                         |
| `pending` | Checks or required review are still pending.                    |
| `unknown` | No PR was found, readiness is ambiguous, or the PR is terminal. |

### Open item IDs

| ID                         | Meaning                                             |
| -------------------------- | --------------------------------------------------- |
| `no_pull_request`          | No pull request was found for the requested target. |
| `status_ambiguous`         | Readiness could not be determined safely.           |
| `merge_conflicts`          | Source control reports merge conflicts.             |
| `branch_out_of_date`       | The branch is behind the base branch.               |
| `merge_blocked`            | Source control reports a mergeability blocker.      |
| `draft`                    | The pull request is still a draft.                  |
| `ci_failing`               | Required checks are failing.                        |
| `changes_requested`        | A reviewer requested changes.                       |
| `unresolved_conversations` | Required review conversations remain open.          |
| `ci_running`               | Checks are still running.                           |
| `review_pending`           | Required review is still pending.                   |

## License

MIT

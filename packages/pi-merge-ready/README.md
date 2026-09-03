# pi-merge-ready

Know if your pull request is ready to merge, what’s blocking it, and let Pi fix what it can.

`pi-merge-ready` keeps current-branch status visible, inspects exact pull request URLs, waits on checks and review, and queues one bounded agent repair attempt for failing CI, merge conflicts, or an out-of-date branch.

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

Use `openItems` to see what must be fixed, waited on, or checked. If the package cannot tell whether a PR is blocked, it includes `status_ambiguous` instead of reporting the PR as ready.

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

`✅ #64 Ready` means an open PR has no `openItems`. Optional unresolved conversations can still appear as context without blocking readiness:

```text
✅ #64 Mergeable · 💬 2 comments
```

When Pi runs in an eligible cmux workspace, the same current-branch status appears in the workspace sidebar:

<img src="https://raw.githubusercontent.com/robhowley/pi-userland/main/packages/pi-merge-ready/img/cmux-pr-status.png" alt="cmux workspace sidebar showing Pi thinking and PR #173 mergeable with one comment" width="422">

`PR #N` links to the pull request URL returned by its provider. cmux publishing is enabled by default when available. Set `pi-merge-ready.cmux.enabled` to `false`, then reload Pi to hide it.

### Attention notifications

cmux sends a notification when the current-branch PR has an actionable merge-readiness change:

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

Or target one exact pull request URL:

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

Start a foreground watcher for the current branch or one exact PR URL:

```bash
/merge-ready watch
/merge-ready watch --url https://github.com/OWNER/REPO/pull/64
/merge-ready watch --url https://github.com/OWNER/REPO/pull/64 --interval 30
```

In the TUI, press `Ctrl-Shift-S` to stop it. In a headless SDK session, abort or dispose the backing session.

| Returned status or lifecycle                                                                                                               | Watch behavior                                     |
| ------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------- |
| `branch_out_of_date`, `merge_conflicts`, `ci_failing`                                                                                      | Queue one bounded agent repair attempt.            |
| `ci_running`, `review_pending`, or an open PR with no `openItems`                                                                          | Keep polling for provider or review state changes. |
| `changes_requested`, `unresolved_conversations`, `merge_blocked`, `draft`, `status_ambiguous`, `no_pull_request`, or a closed or merged PR | Report the blocker or terminal state and stop.     |

Current-branch repair turns use the current checkout and refuse to start with a dirty worktree. URL-targeted repair turns are handed off with instructions to use an isolated worktree for the PR head repo and branch without mutating the current checkout.

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

## Custom source-control providers

A separate Pi extension can register a read-only V1 provider through `@robhowley/pi-merge-ready/provider-api`. The registered object is matched and read directly; pi-merge-ready alone derives `state`, `summary`, and `openItems` from normalized signals.

```ts
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import {
  defineMergeReadyProvider,
  registerMergeReadyProvider,
} from '@robhowley/pi-merge-ready/provider-api';

const provider = defineMergeReadyProvider({
  apiVersion: 1,
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
    const number = input.mode === 'url' ? input.target.prNumber : 7;
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

Load the provider through `pi.extensions`; the API subpath supplies only the contract. Providers are recollected at each session start. Each URL or remote matcher runs once across all providers, and overlapping matches fail explicitly. Reads receive only the documented target fields and are capped at 20 seconds.

Open results return normalized `signals` plus optional supporting `evidence` and ordered `issues` strings. Issues add `status_ambiguous` details without hiding a concrete blocker. Terminal results return only the pull request; providers can also return `absent` or `unavailable`. Harmless extra fields are ignored, while consumed identity, lifecycle, signal, evidence, and issue fields are validated. Duplicate IDs, the reserved `github` ID, matcher failures, malformed results, read failures, and timeouts fail explicitly.

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

| Option                       | Default | Description                                                                              |
| ---------------------------- | ------- | ---------------------------------------------------------------------------------------- |
| `autoCompactRepair`          | `true`  | Compact the conversation after a successful repair turn before polling resumes.          |
| `cacheTTLSeconds`            | `60`    | Cache the current-branch status bar result for this many seconds.                        |
| `enableStatusBarDiagnostics` | `false` | Write status refresh diagnostics as JSONL.                                               |
| `cmux.enabled`               | `true`  | Publish current-branch status and attention notifications to an eligible cmux workspace. |
| `repairGuidance`             | `{}`    | Add blocker-specific instructions to repair handoffs.                                    |

`repairGuidance` accepts only `branch_out_of_date`, `merge_conflicts`, and `ci_failing`. Current-branch repairs combine global and trusted-project guidance. URL-targeted repairs use global guidance only.

When diagnostics are enabled, `PI_MERGE_READY_DEBUG_DIR` overrides their destination for the current process.

## Advanced

### Experimental watch UI

The local watch UI can run several exact-URL watches:

```bash
/merge-ready watch-ui
/merge-ready watch-ui stop
```

After a successful launch, it opens a browser when possible and reports a token-gated localhost URL. It supports stop, restart, remove, and read-only transcript inspection. If its supervisor restarts, previously active watches appear as stale rather than ready.

### Target and lifecycle details

- Closed and merged PRs remain valid exact-URL targets and report their lifecycle.
- URL-targeted results include `pr.headRepository` so agents can verify the editable head repo before changing code.
- URL-targeted command results do not replace the current-branch status bar cache.
- Required unresolved conversations block readiness; optional conversations remain context only.
- Unknown conversation requirements produce `status_ambiguous`.
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

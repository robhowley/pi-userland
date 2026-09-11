# pi-cmux-junction

Branch into parallel Pi sessions: open Git worktrees in new cmux workspaces, fork conversations, and see what every agent is doing at a glance.

## Install

```shell
pi install npm:@robhowley/pi-cmux-junction
```

## Use

From Pi running inside cmux in a Git repository:

```text
/junction --branch <name> [--tab]
/junction --branch <name> --from <commit-ish> [--tab]
/junction fork --branch <name> [--tab]
/junction fork --branch <name> --from <commit-ish> [--tab]
/junction checkout --branch <local-branch> [--tab]
```

Run `/junction` without arguments or `/junction help` to show this help. Add `--tab` as the final argument to open the new Pi session in the same cmux pane and workspace as the current session; otherwise, Junction opens a new workspace. Both leave your current focus unchanged.

- `/junction --branch <name> [--tab]` — create a new worktree from the default base or reuse a matching worktree; start a fresh Pi session.
- `/junction --branch <name> --from <commit-ish> [--tab]` — create a new worktree from the specified commit-ish (never reuse); start a fresh Pi session.
- `/junction fork --branch <name> [--tab]` — wait for the current persisted session to idle, then create a new worktree from the default base or reuse a matching worktree; fork the conversation.
- `/junction fork --branch <name> --from <commit-ish> [--tab]` — wait for the current persisted session to idle, then create a new worktree from the specified commit-ish (never reuse); fork the conversation.
- `/junction checkout --branch <local-branch> [--tab]` — open an existing local branch in its worktree; start a fresh Pi session.

New sessions open in the same directory in the new worktree. If that directory is unavailable, Junction opens the worktree root and warns you. It uses the same Pi config directory and does not create missing directories or copy uncommitted files.

No-`--from` forms use the repository's default base when creating a worktree and may reuse a matching worktree. Forms with `--from <commit-ish>` always create a new branch worktree from that committed ref and reject existing branch or path collisions.

`checkout` requires the exact name of an existing local branch, uses its current tip, and does not accept `--from`.

When opening a tab, Junction creates it and then asks cmux to start Pi. A success message confirms that cmux accepted the start command, not that Pi has finished starting. If startup is uncertain, Junction leaves the tab and worktree in place for inspection. It retries only when it can prove that no tab was created; the retry keeps `--tab` and drops `--from` because the worktree already exists.

## Detailed agent status

Junction adds detailed and accurate live status updates to get quick insight into what your Pi agents are doing. It distinguishes input waits that need your attention from active work:

<img src="https://raw.githubusercontent.com/robhowley/pi-userland/main/packages/pi-cmux-junction/img/status-needs-input-comparison.png" alt="Junction reports Needs input while the standard cmux status reports Running" width="670">

It also identifies the active tool instead of reporting only `Running`:

<img src="https://raw.githubusercontent.com/robhowley/pi-userland/main/packages/pi-cmux-junction/img/status-tool-running-comparison.png" alt="Junction reports Tool running: subagent while the standard cmux status reports Running" width="666">

The pill reports:

- `Idle`
- `Thinking`
- `Tool running` or `Tool running: <name>`
- `Needs input`
- `Compacting`
- `Error`
- `Unknown`

Status pills are enabled by default, but can be disabled in either the global or project `settings.json`:

```json
{ "pi-cmux-junction": { "disableStatus": true } }
```

A project setting overrides the global setting. After editing a settings file directly, run `/reload`; settings from untrusted projects do not apply. Disabling status only hides the pill; `/junction` commands remain available. Junction does not manage cmux session restore.

### Opt-in dashboard publication

Dashboard publication is off by default and independent of `disableStatus`. Set `enablePresentation: true` in global or trusted-project `pi-cmux-junction` settings. Publication also requires an explicit reservation in **global** settings:

```json
{
  "pi-cmux-junction": {
    "enablePresentation": true,
    "descriptionReservations": [
      {
        "socketPath": "/absolute/path/to/cmux.sock",
        "windowId": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        "workspaceId": "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"
      }
    ]
  }
}
```

Replace these example identities with the intended target. Add one reservation per workspace; duplicate matches disable publication for that target. Project settings cannot grant reservation authority. Junction matches the normalized socket path and workspace UUID and pins description operations to the reserved window UUID. It refuses foreign description text; enabling it does not take over native descriptions, install/select a sidebar, or change navigation.

Settings are read at session startup. `/reload` reapplies the local opt-in, but an already-running shared coordinator retains its original reservation until it exits and is relaunched. Both status-first and presentation-first launches receive the same matched global authority. No settings are written automatically.

Producer views belong to the extension instance. Pi replaces that instance on new/resume/fork/reload, so a producer may announce before Junction's `session_start` without its fresh data being cleared. If session identity changes in place, Junction pauses presentation and clears the previous views before accepting the first new event (or during maintenance); shutdown releases the source.

## Worktrees

Worktrees live under:

```text
~/.pi/cmux-junction-worktrees/
```

Their names include the repository owner, repository, and branch when available:

```text
robhowley-pi-userland-feature-example
```

Set `PI_CMUX_JUNCTION_WORKTREE_ROOT` to another location. It accepts an absolute path, `~`, or a path under `~/`.

Junction leaves worktrees in place. It reuses one only when the expected path and branch match; otherwise, it stops without changing existing Git state.

## Manual J2 sidebar prototype (incomplete; not activated)

`extensions/cmux-junction/sidebar/junction-board.swift` is an inert, manually installed
asset for **cmux 0.64.22 (102), commit `ddd4a01bc5d8ebac19643930f5fd7d40e85f1534`**.
Installing this package does not install/select the sidebar or publish descriptions.
Do not use this prototype on workspaces containing descriptions you need to keep.
J2 preserves combining marks and display text without changing cmux. The Node
projector normalizes only accepted href fields once, at publication.
**Phase 6 remains incomplete:** foreign-input UTF-8 byte limits, shared renderer
capacity and installed UI gates remain unresolved.

### J2 wire and publication contract

- Records use actual U+001E (RS); fields use actual U+001F (US); null is a whole
  optional field containing U+001D (GS). These are controls, not control pictures.
- Header: `J2 US sha256(body UTF-8) RS body`, with 64 lowercase ASCII hex digits.
  Existing ordered S/P/C/R records form the exact body; no trailing separator.
  Empty projection still means clear/null, never a header-only board.
- Display fields are unchanged text: no escaping or trimming. The Node projector
  serializes accepted hrefs with `new URL(href).toString()` once; it does not
  normalize labels, titles, summaries or row text. `%`, `%25`, `␞`, `␟` and literal
  `∅` remain ordinary text. Existing Unicode, C0/C1 exclusions, field restrictions
  and input byte limits are unchanged.
- The ASCII body hash distinguishes canonically equivalent spellings that cmux's
  Swift equality would otherwise deduplicate, under the usual SHA-256 collision
  assumption. The renderer checks tag syntax and all body semantics it supports;
  it **cannot recompute SHA-256**. The tag is not authentication or validity proof.
- Publisher checks the body hash and whole-description digest over exact UTF-8;
  exact readback remains authoritative. Preflight/action has no compare-and-swap:
  another writer's intervening change can still be overwritten or cleared.
- Historical internal `presentation-j1.mjs`, `*PresentationJ1`, `MAX_PRESENTATION_J1_*`
  and result `.j1` names now carry J2 only, avoiding changes to existing callers.
  There is no J1 decoder, migration or takeover. Old J1 descriptions are ignored
  by this renderer and remain foreign to the publisher: never auto-overwritten,
  adopted or cleared. Removing an old prototype needs separate manual authority.
- Ceilings remain 16 sources, 64 blocks, 512 cards, 4,096 rows, 4,689 records and
  262,144 bytes. Fields increase from 43,377 to **43,378** for the two-field header.
  Header is 67 bytes (68 with following RS); separators/null now use one byte,
  and escaping adds zero bytes. Metrics count actual output bytes. These ceilings
  are not a claim that the carrier or renderer can admit their simultaneous maximum.

### Offline checks

The exact projector outputs and malformed variants live in `sidebar/fixtures/` next
to the asset. `manifest.json` contains projector inputs, valid SHA-256 digests,
structural counts/bytes, and expected visible text. Invalid metrics describe raw
records, not accepted objects. `.j2` files have **no added newline**.

From this package directory:

```sh
pnpm exec vitest run __tests__/presentation-j1.test.ts __tests__/presentation-j1-fixtures.test.ts __tests__/junction-board-asset.test.ts --reporter=json
```

Without `JUNCTION_SWIFT_INTERPRETER`, the interpreter tests are explicitly skipped;
projector-byte tests still run. Do not call that an interpreter validation.
To run behavior tests, point that variable at an **external pinned cmux interpreter
harness**, not `swift` or a replacement decoder. The harness takes the asset path
as argv[1], reads a JSON object on stdin, evaluates it as cmux state (omit null
object fields), and writes JSON-encoded `RenderNode?` on stdout. Tests execute
whole-workspace rejection, both orders of malformed/valid pairs, every C0/C1
control including CRLF and mark adjacency, fixed actions, progress, unchanged text,
and native workspace order. Eighty Unicode corpus fixtures compare exact JS bytes
and full rendered text in all display-field positions, including both former
combining-mark failures. Swift canonical equality alone is not the test oracle.

A reproducible macOS harness can be built outside this repository from a clean
checkout of that exact cmux commit. Set `CMUX_SOURCE` to its root and `HARNESS` to
a new temporary directory. Put this in `$HARNESS/main.swift`:

```swift
import Foundation
func value(_ x: Any) -> SwiftValue {
    if let x = x as? String { return .string(x) }
    if let x = x as? [Any] { return .array(x.map(value)) }
    if let x = x as? [String: Any] {
        return .object(x.filter { !($0.value is NSNull) }.mapValues(value))
    }
    if let x = x as? Int { return .int(x) }
    return .bool(false)
}
let source = try String(contentsOfFile: CommandLine.arguments[1], encoding: .utf8)
let input = try JSONSerialization.jsonObject(
    with: FileHandle.standardInput.readDataToEndOfFile()) as! [String: Any]
let node = SwiftViewInterpreter().evaluate(source, state: input.mapValues(value))
print(String(data: try JSONEncoder().encode(node), encoding: .utf8)!)
```

```sh
test "$(git -C "$CMUX_SOURCE" rev-parse HEAD)" = ddd4a01bc5d8ebac19643930f5fd7d40e85f1534
export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
HOST="$DEVELOPER_DIR/Toolchains/XcodeDefault.xctoolchain/usr/lib/swift/host"
xcrun swiftc -sdk "$(xcrun --sdk macosx --show-sdk-path)" \
  -I "$HOST" -L "$HOST" -Xlinker -rpath -Xlinker "$HOST" \
  "$CMUX_SOURCE"/Packages/macOS/CmuxSwiftRender/Sources/CmuxSwiftRender/*.swift \
  "$HARNESS/main.swift" -o "$HARNESS/interpreter"
JUNCTION_SWIFT_INTERPRETER="$HARNESS/interpreter" pnpm exec vitest run \
  __tests__/presentation-j1.test.ts __tests__/presentation-j1-fixtures.test.ts \
  __tests__/junction-board-asset.test.ts --reporter=json
```

This uses pinned interpreter source with the local Xcode parser libraries, **not
the installed app's exact linked binary**. Installed validation and visible UI
observations remain separate requirements. `cmux sidebar validate` only accepts
installed sidebar names, not an arbitrary source path.

### Install only after recording the restore target

1. Manually record the currently selected sidebar and the exact way to restore it
   (custom name, or the native UI selection). Stop if this is unknown. Record the
   installed cmux version, explicit socket path and window UUID.
2. Choose two disposable, empty workspaces in that window; record both UUIDs and
   confirm their descriptions are exactly JSON `null`. Do not rely on current
   focus, indexes, environment-inferred workspace IDs, or clearing existing text.
3. Set `ASSET` to this repository's Swift file and `TARGET` to
   `~/.config/cmux/sidebars/junction-board.swift`. In a private temporary directory,
   record whether `TARGET` was absent; otherwise back it up with `cp -p`. Record
   its hash and permissions. Do not touch other assets or cmux configuration.
4. With explicit permission to change the visible sidebar, install and validate:

   ```sh
   install -m 0600 "$ASSET" "$TARGET"
   cmux sidebar validate junction-board --json
   # Continue only after successful validation:
   cmux sidebar reload junction-board --json
   cmux sidebar select junction-board --json
   ```

   On failure, restore the backup/absence and prior selection; do not continue
   injecting fixtures. Never change `sidebar.showWorkspaceDescription` as part
   of this procedure.

### Inject, observe, swap, clean up

Use argv-based calls, not shell interpolation of J2. The following Python helper
shows the exact-match rule; execute it manually in a scratch session after setting
`SOCKET`, `WINDOW`, `WORKSPACE_A`, `WORKSPACE_B`, and `FIXTURES` explicitly. All IDs
must be the recorded UUIDs. Keep the helper/session and fixture bytes until cleanup.
No command below is run by Junction.

```python
import json, os, pathlib, subprocess
socket, window = os.environ['SOCKET'], os.environ['WINDOW']
a, b = os.environ['WORKSPACE_A'], os.environ['WORKSPACE_B']
assert a != b
fixtures = pathlib.Path(os.environ['FIXTURES'])
good = (fixtures / 'every-optional.j2').read_bytes().decode('utf-8')
bad = (fixtures / 'wrong-arity.j2').read_bytes().decode('utf-8')
def call(*args):
    return json.loads(subprocess.check_output([
        'cmux', '--socket', socket, '--json', '--id-format', 'uuids', *args]))
def read(workspace):
    result = call('list-workspaces', '--window', window)
    assert result['window_id'].lower() == window.lower()
    matches = [w for w in result['workspaces'] if w['id'].lower() == workspace.lower()]
    assert len(matches) == 1
    return matches[0]['description']
def replace(workspace, expected, desired):
    assert read(workspace) == expected, 'Changed externally: stop; do not overwrite'
    args = ['workspace-action', '--window', window, '--workspace', workspace,
            '--action', 'clear-description' if desired is None else 'set-description']
    if desired is not None:
        args += ['--description', desired]
    call(*args)
    assert read(workspace) == desired, 'Uncertain result: inspect before continuing'
assert read(a) is None and read(b) is None
replace(a, None, good)
replace(b, None, bad)
# PAUSE: inspect/capture the UI before issuing the next pair.
```

- Verify workspace title, separate source/producer headings, card/row order,
  optional status/summary, progress `2/3`, and both link buttons. Click one HTTPS
  link and record the browser destination. The malformed workspace must show
  exactly `Junction data unavailable`, with **no valid prefix**.
- Record whether native descriptions are visible without changing their setting.
- Swap with `replace(a, good, bad)` and `replace(b, bad, good)`; inspect again.
  Only the malformed workspace should fall back. Preserve cmux's native order.
- Clean up with `replace(a, bad, None)` and `replace(b, good, None)` after the swap
  (use the actual expected bytes if stopped earlier). Confirm both reads are
  `None`. If a call is uncertain or text changed externally, stop and inspect;
  never issue a blind clear. Close only the recorded disposable workspaces after
  successful cleanup, with explicit window/workspace UUIDs.
- Restore the prior sidebar using the recorded method. Restore `TARGET` from its
  backup, or remove it if originally absent, **only if its current bytes still
  equal the installed repository asset**. Preserve backup permissions. Run
  `cmux sidebar reload --all --json`, then verify the prior selection visually
  and compare the restored asset/absence with the backup. Record success/failure.

### Prototype limits and evidence to retain

- The asset uses literal C0/C1 characters, including a literal CR multiline
  string, because this interpreter does not decode Swift backslash escapes.
  Copy/install it byte-for-byte. Editors that normalize CR to LF break control
  rejection; rerun the behavior suite after editing. Git may display it as binary.
- Whole-workspace validation precedes content views. Missing/ordinary/J1
  descriptions are ignored. Bare `J2`, `J2 US` and `J2 RS` prefixes claim the
  description; malformed claims produce one fallback. `J2` plus a combining mark
  is not the exact claim marker. Mixed-version records fail validation.
- Actual framing controls force grapheme breaks. Split/rejoin rejects lost empty
  fields/records before semantic indexing. Control rejection uses split/removal,
  including CRLF as a pair: Foundation `contains` can miss GS followed by a mark.
  GS plus a mark is invalid, never null. No cmux changes or scalar APIs are needed.
- Character ceilings are not UTF-8 byte checks. The renderer does not reimplement
  WHATWG or IDNA parsing. A non-null href is valid structural text; a button is
  emitted only for lowercase `https://`, a lowercase ASCII DNS host with nonempty
  dot-separated labels using `a-z`, `0-9`, `.` and `-`, an optional decimal port
  from 0 through 65535 except normalized default port 443, and a path/query/fragment
  with no URL whitespace or backslash. IPv6, userinfo, escaped or non-ASCII hosts,
  other schemes, and malformed/unsupported values stay visible as text with no
  action. The projector's Node URL normalization makes accepted producer inputs
  deterministic; foreign descriptions still use this renderer allowlist.
- No renderer admission, truncation, per-workspace ceiling or retries exist. The
  host shares a 3,000-RenderNode budget across the whole sidebar; deliberately
  oversized input can fail the entire evaluation, including other valid workspaces.
  Prior pinned testing reached that failure with 64 cards and 1,024 rows below the
  proposed 65,536-byte carrier target. J2 does not reduce node counts or resolve
  admission. Do not infer a card ceiling or silently lower input capacity.
- Retain fixture filenames/digests/counts/UTF-8 bytes, validation JSON, screenshots,
  link destination, exact readbacks and cleanup/restore evidence. Once the visible
  prototype works, measure actual view-node counts, refresh behavior and memory
  for representative fixtures; decide any guardrail from those observations,
  before Phase 7 activation if the risk is material.

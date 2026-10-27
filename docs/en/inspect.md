# Push size check

`yunbox inspect` checks the Git content and LFS pointers you have committed. It doesn't upload anything or rewrite history, and it doesn't need a YunBox server or git-lfs to be installed. Build directories that aren't committed are not counted.

If you prefer a window to the command line, install the [macOS app](./guide/macos). It uses the JSON output described below and lets you pick a repository, filter files and copy the report.

```bash
yunbox inspect --push
yunbox inspect --push --base origin/main --head HEAD --json
yunbox inspect --push --git-limit 900k --lfs-limit 100m --file-limit 10m --top 20
yunbox inspect --push --confirm   # ask for confirmation when over budget; see below
yunbox inspect --push --confirm-always   # ask even when within budget
```

By default, `yunbox inspect` compares HEAD with your local snapshot of the upstream branch. If there is no upstream, it checks the whole history of HEAD and tells you so.

`--stdin` reads the four-column ref updates that Git passes to a pre-push hook. It handles several branches and deletions in one push, and can't be combined with `--base` / `--head`.

If an existing remote branch's old tip is missing locally, inspection fails with exit code `2` and asks you to run `git fetch`. It no longer presents unreliable sizes and file statuses as a passed check. Retry after fetching. Inspection never fetches automatically, changes refs, or downloads LFS content.

Remote Git refs are only queried when you pass `--remote <name/url>` explicitly for a new branch, to exclude locally readable history already on the remote. A failed query or remote objects missing locally produces an explicit conservative-estimate warning. For repositories connected directly to COS, YunBox also checks whether LFS objects are already uploaded; see below.

## Terminal reports

Reports show code and asset destinations before upload budgets and changed files. Direct COS / S3 mode is identified explicitly; a clone without its agent receives setup instructions. `yunbox status` uses the same display and reads only local configuration and files, without checking keys or network access.

Interactive terminals highlight passed checks in green, warnings in yellow, and failures or over-budget files in red. Pipes, redirected output, CI and JSON contain no color escapes. `NO_COLOR=1` disables color. See the [FAQ](./guide/faq) for cross-platform examples.

## What gets counted

- **Incremental Git upload**: an estimate of the local thin pack, covering commits, trees, ordinary files and LFS pointers, including compression and delta encoding. Counting stops once it passes `max(10 MiB, Git limit)`, and the report then shows a lower bound instead of an exact value. Protocol handshake overhead isn't included, and this estimate does not establish upload success.
- **Git file details**: the raw size of ordinary blobs, excluding anything recognized as an LFS pointer. Identical content is counted once (deduplicated by object ID), but each historical version counts separately, including large files that were deleted later. Raw size is not the same as the compressed, delta-encoded amount actually sent over the network.
- **LFS candidate size**: asset sizes read from the pointers in the pushed history, deduplicated by LFS SHA-256. A new branch keeps the candidates from its whole history, even when the Git pack can leave out objects that other remote branches already have.
- **Actual LFS upload size**: when the repository is [connected directly to COS](./guide/) and this machine has a key (from `yunbox login`, `TENCENTCLOUD_*` or `tccli auth login`), YunBox sends one HEAD request to COS per candidate. This is the same check the transfer agent runs before uploading, and it only needs the `HeadObject` permission. Objects that already exist with the same size don't count toward the upload, and `uploadBytes` gives an exact value. The LFS budget, the per-file budget and the upload size of changed files are all based only on objects that actually need uploading.
  - At most 8 requests run at a time, with a 5-second limit overall. If any request fails (missing permission, network error) or the limit is hit, the whole lookup is discarded: you get only the candidate size, as before, plus a note explaining why. This never blocks the push, and an object that couldn't be checked is never treated as uploaded.
  - Set the environment variable `YUNBOX_INSPECT_REMOTE_TIMEOUT_MS` to change the time limit, or to `0` to turn the lookup off.
  - Repositories that use a YunBox server (`lfs.url`) or aren't set up with YunBox are not checked, so their actual upload size is unknown.
- **Changed files**: changes in the pushed commits summed up per path, like `git diff --stat` with sizes added. For each path you get:
  - the status: added, modified, deleted, or transient (added and then deleted within this push; the content is still uploaded)
  - the size before and after the push (for LFS, the asset size)
  - how many versions this push uploads, and their total raw size

  Files are sorted by raw content size, largest first. Neither that size nor the difference between before and after sizes represents the network upload; use the total pack estimate for Git. When several paths share the same content, each path counts it. Ordinary Git statuses use the incremental Git range rather than the full conservative LFS history of a new branch. LFS candidates are still retained conservatively. The before and after states come from the earliest and the latest change, so they are approximate when you push several branches at once.
- **Per-file limit**: applies to both ordinary Git files and LFS assets. Text output shows the top 10 changed files (raise it to at most 100 with `--top`). JSON output includes every change and object, the paths found for them, exact byte counts and over-budget flags. Objects whose path is unknown are listed separately by object ID.

The default budgets are **900 KiB** for the Git pack, **100 MiB** for total LFS candidates and **10 MiB** per file. These are local check budgets, not quotas of any hosting platform. Going over any one of them makes the result over budget; a value exactly at the budget passes. Command-line flags take precedence over repository or global Git config:

```bash
git config yunbox.inspectGitBytes 900k
git config yunbox.inspectLfsBytes 100m
git config yunbox.inspectFileBytes 10m
```

Values can be plain byte counts or use `k/m/g` or `KiB/MiB/GiB`; all units are powers of 1024.

Exit codes: `0` allowed (within budget or explicitly approved), `1` blocked by a budget, freeze, or missing confirmation, `2` the check failed. Missing objects, invalid pointers, timeouts and analysis output that grows too large all count as failures. A failure never means "zero traffic".

## JSON output

With `--json`, stdout contains exactly one JSON object, even when something goes wrong. `--help` still prints the help text. `schemaVersion` is currently `1`, so Craft Hub or CI can build on it later.

| Field | Meaning |
| --- | --- |
| `status` | `ok`, `exceeded` or `error` |
| `limits` | `gitBytes`, `lfsBytes`, `fileBytes` |
| `git.packBytes` / `packComplete` | The full estimate. When the estimate is incomplete, `packBytes` is `packCapBytes + 1` and should be read as a lower bound |
| `git.blobBytes` / `blobCount` / `pointerBytes` | Raw size and number of Git blobs (pointers included), and how much of that is pointers |
| `git.exceedsLimit` / `lfs.exceedsLimit` | Whether each total is over its budget. Per-file overruns are flagged on each entry instead |
| `changes` | One entry per changed path: `{ path, status, storage, beforeBytes, afterBytes, beforeOid, afterOid, versions, pushBytes, exceedsFileLimit }`. The existing `pushBytes` field always means total raw content bytes across versions, not compressed upload bytes. `status` is `added`, `modified`, `deleted` or `transient`; `storage` is `git` or `lfs`. A size is `null` when the path doesn't exist or the old object isn't available locally. `versions` of `0` means there's no new content to upload (for example a deletion, or an LFS object already in COS). Added later; `schemaVersion` is still `1` |
| `changes[].beforeOid` / `afterOid` | Content IDs before and after the push, for reading that exact version. For LFS files it's the asset's SHA-256 (stored locally at `.git/lfs/objects/<first 2 chars>/<chars 3–4>/<oid>`, and possibly not downloaded yet). For ordinary files it's the Git blob ID (`git cat-file blob <oid>`). It is `null` whenever the matching size is `null`. Don't read from the working tree, which may differ from the pushed commits. Added later; `schemaVersion` is still `1` |
| `git.files` / `lfs.files` | Full object lists, sorted by size (largest first). Each entry is `{ oid, bytes, paths, exceedsFileLimit }`. `exceedsFileLimit` means the object is over the per-file budget and needs uploading; it is `false` for LFS objects already in COS |
| `lfs.files[].onRemote` | Present only when `lfs.remoteChecked` is `true`: whether the storage already has this object (so the push skips it). Added later; `schemaVersion` is still `1` |
| `lfs.candidateBytes` / `candidateCount` | Size and count of deduplicated LFS candidates |
| `lfs.remoteChecked` / `uploadBytes` | `true` / the number of LFS bytes to upload when the storage was queried; otherwise `false` / `null`. Never treat an unknown upload size as `0`. When the storage was queried, `lfs.exceedsLimit` is based on `uploadBytes`; otherwise on `candidateBytes` |
| `lfs.remoteStorage` | Present only when `lfs.remoteChecked` is `true`: which storage was queried (`COS`, `S3`). Added later; `schemaVersion` is still `1`; older versions without it only query COS |
| `warnings` | Notes such as conservative estimates or the upstream snapshot being used |
| `error` | Present only on failure: `{ code: "INSPECTION_FAILED", message }`. Raw Git errors and remote URLs are never included |

## Confirming over-budget pushes

With `--confirm`, an over-budget result asks whether to go on. If you confirm, the exit code is `0`; if you cancel, or there's no way to ask, it is `1`. `--confirm` can't be combined with `--json`. Like the rest of the CLI's messages, the dialog and terminal prompt are in Chinese for now.

`--confirm-always` asks on every check, even within budget, using a regular confirmation title. Continuing returns `0`; cancelling, closing the window, or having no available interface returns `1`. It also cannot be combined with `--json` and follows `--confirm-ui`. Inspection errors and push freezes still stop the push directly.

```bash
yunbox hook install --confirm-always          # every push in this repository
yunbox hook install --global --confirm-always # every push covered by global protection
git config yunbox.confirmMode always         # existing --confirm hooks, without reinstalling
git config yunbox.confirmMode exceeded       # restore the default: ask only over budget
yunbox hook install --confirm-mode exceeded  # explicitly override the Git preference
```

`--confirm-always` / `--confirm-mode exceeded|always` takes precedence over `yunbox.confirmMode`, which defaults to `exceeded`. Manual inspection requires `--confirm` with `--confirm-mode`. Checks without confirmation and `--no-confirm` hooks ignore this preference. The macOS **Help → Setup Assistant → Push protection** step also offers a **Show a confirmation for every push** toggle; apply the setting to enable it. `hook status --json` reports the effective policy as `confirmAlways`. This UI is the push confirmation panel; the full client can still be opened with its button inside the panel.

- **macOS**: a native dialog appears (run through `osascript`, so no app needs to be installed).
  - The title names the push target (such as `github.com/owner/repo`, without credentials). The line below it shows the local repository name and the branches being pushed.
  - A row of buttons lets you show the repository in Finder, open it in an installed editor (Cursor, VS Code, Zed or Sublime Text), see the full details in the YunBox app (if installed), or open the remote repository page in your browser; each button shows the icon of the app it opens. None of these buttons close the dialog.
  - Below that are usage bars for the three budgets (Git pack, LFS candidates, largest single file), then a table with one row per file: status, folder and file name, size before and after the push and the difference, number of versions, and a bar for this push's upload size. Over-budget files are shown in red.
  - Click a file that still exists after the push to preview the pushed version in Quick Look. For a modified file, both the before and after versions open, and the Left and Right arrow keys switch between them; an added file shows only the new version. Modified ordinary Git text files (up to 1 MiB per version) get an extra page: a line-by-line diff with line numbers on both sides and red/green highlighting. The pushed version appears first, followed by the diff when it is ready; if you have already switched to the old version, that selection is preserved. Diffs are generated on demand and reused on repeated views. Like the report page, they contain no scripts. Previewing doesn't close the dialog. Close the preview with its close button or Esc; while a preview is open, Esc in the dialog also closes the preview rather than cancelling the push.
  - Previews come from Git objects or local LFS storage (`.git/lfs/objects`), not from the working tree, because the working tree may differ from the pushed commits. They are copied to a temporary directory that only the current user can read, and deleted when the dialog closes. Old LFS versions that aren't available locally can't be previewed.
  - The report page contains no scripts, and its content security policy stays at `default-src 'none'`. With many files, only the table scrolls; the usage bars and the table header stay in place.
  - Under the table is an optional reason field, focused when the dialog opens: type why you're cancelling or going ahead, then click either button, or leave it empty. The reason appears in the push output, so whoever started the push, or the AI coding assistant that did, can see it; both cancelling and continuing record the decision in local Push Protection History.
  - The destination, exceeded budgets and decision buttons appear first, followed by the file list. You can cancel or continue while the list is loading. The default button is Cancel, so Return cancels. With no preview open, Esc or closing the confirmation window also cancels the push. The dialog lists at most 300 files; use `--json` to see the rest.
- **Windows / Linux / terminal-only macOS**: you are asked `[y/N]` on the controlling terminal: the attached console on Windows, or `/dev/tty` on macOS / Linux. This does not read pre-push standard input. A reason can follow the answer, such as `n compress the images first` or `y approved by the art team`. Return cancels; SSH uses the terminal by default. On Windows, use PowerShell / Windows Terminal; Git Bash requires an attached Windows console.
- **No way to ask** (no window or controlling terminal): the push is blocked with a message; approval is never assumed.

When a push is cancelled, the output gives the reason (if one was typed) and says not to raise the budgets or bypass the check with `--no-verify`, so an AI coding assistant that started the push knows what to do next.

Choose `auto`, `dialog`, `terminal` or `none` (do not ask; block pushes that require confirmation). Precedence: `--confirm-ui` > `YUNBOX_CONFIRM_UI` > Git setting `yunbox.confirmUI` > `auto`. `--confirm-ui` requires `--confirm` or `--confirm-always`. A saved preference also applies to pre-push wrappers installed with `--confirm`:

```bash
git config yunbox.confirmUI terminal          # This repository: terminal only
git config --global yunbox.confirmUI terminal # Default for all repositories
git config yunbox.confirmUI auto              # Automatic choice in this repository
yunbox inspect --push --confirm --confirm-ui terminal # Override this check only
```

On macOS, `auto` uses the native window locally (with a button to open the YunBox app), and the terminal over SSH. Explicit `dialog` attempts the native window, then falls back to the terminal if unavailable.

## Local push protection history

Within-budget decisions in always-confirm mode use `reason: confirmation`, rather than an exceeded-budget reason. An unavailable interface records `blocked`, a user cancellation records `cancelled`, and approval records `continued`.

The hook appends a project-scoped decision for freezes, budget blocks, user cancellations and confirmed continuations, with a timestamp, reason, outcome and optional user note. Manual inspections do not record history. A continuation means the check allowed the push; Git reports the subsequent upload result.

History stays in `~/.config/yunbox/push-history.json` on the user’s computer, with `YUNBOX_CONFIG_DIR` or `XDG_CONFIG_HOME` overrides. It is not committed. Retention is 90 days, 200 decisions per project and 5,000 overall. Existing latest entries from the old format are imported. In the macOS app, use Push Protection History to filter by project, view decisions and clear them.

```bash
yunbox history                      # Current project
yunbox history --all --json         # All local projects
yunbox history clear --yes          # Clear current project
yunbox history clear --all --yes    # Clear all local history
```

Clearing also removes the corresponding legacy blocked snapshot so it does not reappear. It leaves hooks, Git settings, assets and keys intact. Cleared history cannot be recovered.

## Push freeze

`yunbox freeze` sets windows during which pushing isn't allowed (for example working hours or a release freeze). Inside a window, pre-push stops the push outright, and `--confirm` can't let it through. `yunbox freeze off` turns it off temporarily. For window syntax, team sharing, Quick off and JSON output, see [Push freeze](./guide/freeze).

## Run before uploading

Registering several independent `pre-push` hooks doesn't guarantee that a failure stops the push: Git may still run a later LFS upload hook. If you use LFS, run `git lfs install --local` first, then install the wrapper that runs the hooks in sequence:

```bash
yunbox hook install
# Confirmation is the default; to block immediately instead:
yunbox hook install --no-confirm
# Use Workstation's macOS dialog/terminal confirmation instead of blocking over-budget pushes outright:
yunbox hook install --guard ~/.local/libexec/git-confirm-large-push
# Restore the original hook:
yunbox hook uninstall
```

By default, the wrapper calls the installed YunBox CLI and asks before an over-budget push. Cancelling or having nobody available to answer blocks the push. It works with the app closed; `--confirm` explicitly selects this default. `--guard` takes the absolute path of an executable; its exit code decides whether the original hook runs. The Workstation adapter only checks GitHub remotes.

The original hook is kept as `pre-push.yunbox-original`, and its arguments and stdin are passed through unchanged. Installing again doesn't wrap the wrapper, and uninstalling restores the original file. The wrapper refuses to overwrite modified wrappers, symbolic links, or unregistered backups. For a custom `core.hooksPath`, use local compatibility mode below or chain YunBox through the original manager. After moving or uninstalling the CLI or the guard, install the wrapper again.

The wrapper only controls the repository hook it saved. If other independently configured hooks also upload assets, their own managers have to put them in sequence. Running `git lfs install` after installing the wrapper may report that a hook already exists. To update the LFS hook, uninstall the wrapper, update the hook, then install the wrapper again. `git push --no-verify` skips the pre-push check entirely.

## Optional global protection

```bash
yunbox hook install --global       # Repositories without a custom hooks directory; ask when over budget
yunbox hook status --json          # Effective scope, confirmation mode and local prerequisites
yunbox hook uninstall --global     # Restore each repository's original hooks
```

Global mode sets Git's `core.hooksPath`, runs the check before the repository's original pre-push, and forwards the other standard Git hooks, including LFS checkout hooks. It refuses to overwrite an existing global or system hooks directory. Repository-specific directories override the global setting. Existing YunBox repository wrappers take precedence to avoid duplicate checks and retain their confirmation mode. Independently configured upload hooks still need their own manager to guarantee ordering.

`git yunbox init` installs repository protection by default and asks in an interactive terminal; `--yes` or non-interactive runs accept the default. Use `init --no-hook` for storage only or `init --global-hook` to explicitly opt into global protection. These flags cannot be combined. Reinitialization preserves existing protection and LFS hooks. With global mode enabled, configure LFS through `yunbox init`; running `git lfs install` directly may report a wrapper conflict in the shared directory.


## Local compatibility mode

For repositories using Husky, `scripts/git-hooks`, or a deployment tool's hooks directory, compatibility mode preserves team hooks:

```bash
yunbox hook install --compatible             # Ask when over budget; then run the original pre-push
yunbox hook install --compatible --no-confirm # Block over-budget pushes
yunbox hook status --json                    # Check effective coverage
yunbox hook repair                           # Reconnect after another tool resets the path
yunbox hook uninstall                        # Restore the original local setting; keep later edits
```

The dispatcher lives in `yunbox-hooks` under Git's metadata directory. It changes only the local `core.hooksPath`, leaving `.husky`, project scripts, and `node_modules` untouched. Push input is captured once; Git's arguments and complete stdin reach both YunBox and the original `pre-push`. Rejection, cancellation, or a failed check prevents the original checks and uploads. Other standard Git hooks are forwarded with their arguments, stdin, exit codes, and working directory intact. Updates to original scripts take effect immediately. An existing YunBox repository wrapper remains authoritative, including its confirmation mode, to avoid duplicate checks.

| Scenario | Behavior |
| --- | --- |
| Standard `.git/hooks` | Keep the repository wrapper or optional global mode |
| Husky | Forward to its configured directory, such as `.husky/_`, preserving user scripts; recheck after installing dependencies |
| Project hooks directory | Save the original path and local setting for restoration; relative paths retain Git's hook working-directory semantics |
| Generated directory | Prefer the tool's documented extension point when available; the generic dispatcher only forwards and never edits generated files |
| Missing original directory | Stop execution until restored; `.husky` / `node_modules` paths suggest missing dependencies, without automatically clearing settings |

If a directory is obsolete, uninstall compatibility mode first, then run `yunbox hook clear-missing`. This only removes a single missing path stored directly in the current local configuration scope. Inherited settings, multiple values, and existing directories must be handled at their source. Check `hook status` afterwards: protection depends on the configuration that becomes effective.

In `hook status --json`, `globalInstalled` only indicates global enablement; `hook` and `scope` describe effective repository protection. Compatibility mode uses `scope: compatible`. Its `compatibility.state` is `active`, `pending`, `overridden`, `missing`, or `modified`. If Husky or another tool resets the path, repeated installation reports that protection was overridden. `hook repair` explicitly adopts the currently configured directory as the new forwarding target. Uninstall preserves a path subsequently changed by the user.

Linked worktrees with shared configuration share the dispatcher, resolving relative paths in their own working trees. When `extensions.worktreeConfig` is enabled, new installations change only the current worktree's configuration. A later Git `include` or command-level setting can still override installation; YunBox verifies the effective path and rolls back if it did not take effect. Modified dispatchers or manifests are retained for inspection.

On macOS, **Help → Setup Assistant → Enable push protection** provides connect, repair, restore, and obsolete-setting cleanup actions. It shows global enablement separately from coverage of known repositories, with unreadable repositories counted separately. It refreshes when opened, when the app becomes active, or when you choose **Check again**. Recheck after installing dependencies: global enablement does not mean every repository is protected.

For compatible repositories, `yunbox init` configures LFS filters without writing team hooks. If it cannot recognize `git lfs pre-push` in the original hook or Husky user script, it asks you to integrate LFS through the original manager using `git lfs update --manual`. Complex scripts invoking LFS indirectly require maintainer review and explicit integration. Upload is never registered as a separate independent hook.

As with the standard wrapper, independently configured upload hooks still require ordering in their own manager, and `--no-verify` retains its Git behavior. Consult the [Git hook reference](https://git-scm.com/docs/githooks) and [Husky documentation](https://typicode.github.io/husky/how-to.html) for project-specific extension points.

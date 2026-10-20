# Push size check

`yunbox inspect` checks the Git content and LFS pointers you have committed. It doesn't upload anything or rewrite history, and it doesn't need a YunBox server or git-lfs to be installed. Build directories that aren't committed are not counted.

If you prefer a window to the command line, install the [macOS app](./guide/macos). It uses the JSON output described below and lets you pick a repository, filter files and copy the report.

```bash
yunbox inspect --push
yunbox inspect --push --base origin/main --head HEAD --json
yunbox inspect --push --git-limit 900k --lfs-limit 100m --file-limit 10m --top 20
yunbox inspect --push --confirm   # ask for confirmation when over budget; see below
```

By default, `yunbox inspect` compares HEAD with your local snapshot of the upstream branch. If there is no upstream, it checks the whole history of HEAD and tells you so.

`--stdin` reads the four-column ref updates that Git passes to a pre-push hook. It handles several branches and deletions in one push, and can't be combined with `--base` / `--head`.

Remote Git refs are only queried when you pass `--remote <name/url>` explicitly, and only for a new branch or when the old tip is missing. If that query fails, or the remote objects aren't available locally, the estimate errs on the high side. Nothing is fetched and no LFS content is downloaded. For repositories connected directly to COS, YunBox does check whether the LFS objects are already uploaded; see below.

## What gets counted

- **Git pack**: an estimate of the local thin pack, covering commits, trees, ordinary files and LFS pointers. Counting stops once it passes `max(10 MiB, Git limit)`, and the report then shows a lower bound instead of an exact value. Protocol handshake overhead isn't included.
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

  Files are sorted by upload size, largest first. When several paths share the same content, each path counts it. The before and after states come from the earliest and the latest change, so they are approximate when you push several branches at once.
- **Per-file limit**: applies to both ordinary Git files and LFS assets. Text output shows the top 10 changed files (raise it to at most 100 with `--top`). JSON output includes every change and object, the paths found for them, exact byte counts and over-budget flags. Objects whose path is unknown are listed separately by object ID.

The default budgets are **900 KiB** for the Git pack, **100 MiB** for total LFS candidates and **10 MiB** per file. These are local check budgets, not quotas of any hosting platform. Going over any one of them makes the result over budget; a value exactly at the budget passes. Command-line flags take precedence over repository or global Git config:

```bash
git config yunbox.inspectGitBytes 900k
git config yunbox.inspectLfsBytes 100m
git config yunbox.inspectFileBytes 10m
```

Values can be plain byte counts or use `k/m/g` or `KiB/MiB/GiB`; all units are powers of 1024.

Exit codes: `0` within budget, `1` over budget, `2` the check failed. Missing objects, invalid pointers, timeouts and analysis output that grows too large all count as failures. A failure never means "zero traffic".

## JSON output

With `--json`, stdout contains exactly one JSON object, even when something goes wrong. `--help` still prints the help text. `schemaVersion` is currently `1`, so Craft Hub or CI can build on it later.

| Field | Meaning |
| --- | --- |
| `status` | `ok`, `exceeded` or `error` |
| `limits` | `gitBytes`, `lfsBytes`, `fileBytes` |
| `git.packBytes` / `packComplete` | The full estimate. When the estimate is incomplete, `packBytes` is `packCapBytes + 1` and should be read as a lower bound |
| `git.blobBytes` / `blobCount` / `pointerBytes` | Raw size and number of Git blobs (pointers included), and how much of that is pointers |
| `git.exceedsLimit` / `lfs.exceedsLimit` | Whether each total is over its budget. Per-file overruns are flagged on each entry instead |
| `changes` | One entry per changed path: `{ path, status, storage, beforeBytes, afterBytes, beforeOid, afterOid, versions, pushBytes, exceedsFileLimit }`. `status` is `added`, `modified`, `deleted` or `transient`; `storage` is `git` or `lfs`. A size is `null` when the path doesn't exist or the old object isn't available locally. `versions` of `0` means there's no new content to upload (for example a deletion, or an LFS object already in COS). Added later; `schemaVersion` is still `1` |
| `changes[].beforeOid` / `afterOid` | Content IDs before and after the push, for reading that exact version. For LFS files it's the asset's SHA-256 (stored locally at `.git/lfs/objects/<first 2 chars>/<chars 3–4>/<oid>`, and possibly not downloaded yet). For ordinary files it's the Git blob ID (`git cat-file blob <oid>`). It is `null` whenever the matching size is `null`. Don't read from the working tree, which may differ from the pushed commits. Added later; `schemaVersion` is still `1` |
| `git.files` / `lfs.files` | Full object lists, sorted by size (largest first). Each entry is `{ oid, bytes, paths, exceedsFileLimit }`. `exceedsFileLimit` means the object is over the per-file budget and needs uploading; it is `false` for LFS objects already in COS |
| `lfs.files[].onRemote` | Present only when `lfs.remoteChecked` is `true`: whether COS already has this object (so the push skips it). Added later; `schemaVersion` is still `1` |
| `lfs.candidateBytes` / `candidateCount` | Size and count of deduplicated LFS candidates |
| `lfs.remoteChecked` / `uploadBytes` | `true` / the number of LFS bytes to upload when COS was queried; otherwise `false` / `null`. Never treat an unknown upload size as `0`. When COS was queried, `lfs.exceedsLimit` is based on `uploadBytes`; otherwise on `candidateBytes` |
| `warnings` | Notes such as conservative estimates or the upstream snapshot being used |
| `error` | Present only on failure: `{ code: "INSPECTION_FAILED", message }`. Raw Git errors and remote URLs are never included |

## Confirming over-budget pushes

With `--confirm`, an over-budget result asks whether to go on. If you confirm, the exit code is `0`; if you cancel, or there's no way to ask, it is `1`. `--confirm` can't be combined with `--json`. Like the rest of the CLI's messages, the dialog and terminal prompt are in Chinese for now.

- **macOS**: a native dialog appears (run through `osascript`, so no app needs to be installed).
  - The title names the push target (such as `github.com/owner/repo`, without credentials). The line below it shows the local repository name and the branches being pushed.
  - A row of buttons lets you show the repository in Finder, open it in an installed editor (Cursor, VS Code, Zed or Sublime Text), see the full details in the YunBox app (if installed), or open the remote repository page in your browser. None of these buttons close the dialog.
  - Below that are usage bars for the three budgets (Git pack, LFS candidates, largest single file), then a table with one row per file: status, folder and file name, size before and after the push and the difference, number of versions, and a bar for this push's upload size. Over-budget files are shown in red.
  - Click a file that still exists after the push to preview the pushed version in Quick Look. For a modified file, both the before and after versions open, and the Left and Right arrow keys switch between them; an added file shows only the new version. Modified ordinary Git text files (up to 1 MiB per version) get an extra page: a line-by-line diff with line numbers on both sides and red/green highlighting. The preview opens on this page; press the Left arrow to get back to the two versions. Diff pages are generated before the dialog opens (for up to 100 files) and, like the report page, contain no scripts. Previewing doesn't close the dialog; press Esc to close the preview.
  - Previews come from Git objects or local LFS storage (`.git/lfs/objects`), not from the working tree, because the working tree may differ from the pushed commits. They are copied to a temporary directory that only the current user can read, and deleted when the dialog closes. Old LFS versions that aren't available locally can't be previewed.
  - The report page contains no scripts, and its content security policy stays at `default-src 'none'`. With many files, only the table scrolls; the usage bars and the table header stay in place.
  - The default button is Cancel. The dialog lists at most 300 files; use `--json` to see the rest.
- **Other environments**: you are asked `[y/N]` on the controlling terminal (`/dev/tty`), below the same text report. SSH sessions use the terminal directly.
- **No way to ask** (no window, no terminal, or Windows): the push is blocked with a message.

Set the environment variable `YUNBOX_CONFIRM_UI` to `dialog`, `terminal` or `none` (don't ask, just block) to choose the method. By default it is picked automatically.

## Push freeze

`yunbox freeze` sets windows during which pushing isn't allowed (for example working hours or a release freeze). Inside a window, pre-push stops the push outright, and `--confirm` can't let it through. `yunbox freeze off` turns it off temporarily. For window syntax, team sharing, Quick off and JSON output, see [Push freeze](./guide/freeze).

## Run before uploading

Registering several independent `pre-push` hooks doesn't guarantee that a failure stops the push: Git may still run a later LFS upload hook. If you use LFS, run `git lfs install --local` first, then install the wrapper that runs the hooks in sequence:

```bash
yunbox hook install
# Show a confirmation dialog when over budget instead of blocking right away:
yunbox hook install --confirm
# Use Workstation's macOS dialog/terminal confirmation instead of blocking over-budget pushes outright:
yunbox hook install --guard ~/.local/libexec/git-confirm-large-push
# Restore the original hook:
yunbox hook uninstall
```

By default, the wrapper calls the YunBox CLI you have installed and exits if the check doesn't pass. `--guard` takes the absolute path of an executable; its exit code decides whether the original hook runs. The Workstation adapter only checks GitHub remotes.

The original hook is kept as `pre-push.yunbox-original`, and its arguments and stdin are passed through unchanged. Installing again doesn't wrap the wrapper, and uninstalling restores the original file. The wrapper refuses to overwrite anything if it finds that you edited the wrapper, set a custom `core.hooksPath`, used a symbolic link, or have a backup it didn't record. If you use a custom hook manager, chain YunBox into it in sequence yourself. After moving or uninstalling the CLI or the guard, install the wrapper again.

The wrapper only controls the repository hook it saved. If other independently configured hooks also upload assets, their own managers have to put them in sequence. Running `git lfs install` after installing the wrapper may report that a hook already exists. To update the LFS hook, uninstall the wrapper, update the hook, then install the wrapper again. `git push --no-verify` skips the pre-push check entirely.

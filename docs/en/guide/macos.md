# macOS app

A small native SwiftUI app. It runs the YunBox command line bundled inside it, so it uses exactly the same Git and LFS checks.

## Install

Download the latest `YunBox-macOS.zip` from [the website](/en/#download), unzip it and drag YunBox into Applications. You need macOS 14 or later and Node.js 22.18+ on your Mac.

From 0.1.5 on, the app is notarized by Apple, so it opens with a double-click and macOS no longer says the developer can't be verified.

::: details Version 0.1.4 and earlier
These versions aren't notarized. If the first launch says the developer can't be verified, go to System Settings → Privacy & Security and click Open Anyway, or run this in Terminal:

```bash
xattr -dr com.apple.quarantine /Applications/YunBox.app
```

Apps from 0.1.4 and earlier can't update themselves yet, so download the latest version and replace the app.
:::

You can also build it from source, with Xcode or developer tools that include Swift 6:

```bash
pnpm install
./script/build_and_run.sh --install   # installs to ~/Applications/YunBox.app and opens it
```

## Updates

The app updates itself with [Sparkle](https://sparkle-project.org). It checks once a day in the background; when there's a new version it shows the release notes, and Install Update downloads it, replaces the app and reopens it. You can also check any time from YunBox → Check for Updates…, or go to Settings → Software Update to turn off automatic checks or have updates downloaded and installed automatically.

Updates and their release notes are signed, and the app only installs an update whose signature matches the public key built into it. Version 0.1.4 and earlier can't update themselves yet, so [download](/en/#download) a new version by hand once. To see what changed in each version, read the [changelog](../changelog); it also opens from the Help menu and from Settings → Software Update.

## Interface language

The app comes in Simplified Chinese and English and follows your system language by default. To choose one just for YunBox, use Settings → Language; it takes effect after the app reopens. System Settings → General → Language & Region → Applications changes the same setting. Release notes in the update prompt follow the interface language too. Messages printed by the command line (such as the checks in `yunbox doctor`) are only in Chinese for now. The website and documentation are available in Simplified Chinese and English.

## What it does

- **Push size**: choose or drag in a Git repository to see its estimated Git pack size and LFS candidate size, its budgets and whether anything is over. For repositories connected directly to COS, it shows how much LFS data actually needs uploading, and files already in COS are marked In COS. Files are sorted largest first, and you can search, filter by type, or show only files over budget.
- **File details**: select a file to see how it changes with the push. Images can be shown side by side, compared with a draggable divider, or toggled back and forth. Text files show a diff, either unified or split. Anything else can be opened in Quick Look, before and after. Content comes from the commits being pushed, not from your working tree. You can also copy the path or show the file in Finder.
- **Storage status**: next to the repository title you'll see which storage the repository uses directly and how it's doing, such as "Direct COS · OK", "Direct R2 · Needs attention" or "Storage not connected" (Tencent Cloud COS shows as COS; S3-compatible storage shows as R2, AWS S3 or MinIO based on the endpoint, and other services as S3). Click it to open the Storage panel with each `yunbox doctor` check and the commands that fix problems.
- **Hand setup to AI**: Copy Setup Prompt for AI in the Storage panel builds a prompt with the steps for the repository's storage (or, before it's connected, for the storage chosen in the panel) that you can paste into a coding assistant. See [Set up with an AI coding assistant](./ai).
- **One-click setup**: for a repository that isn't connected yet, first choose the storage in the panel:
  - **Tencent Cloud COS**: pick an existing bucket or create a private one, enter a folder prefix, and the panel runs `git yunbox init` for you.
  - **S3-compatible storage**: choose Cloudflare R2 (enter your account ID), AWS S3 (enter the region), MinIO or another service (enter the endpoint), then the bucket and folder prefix, and the panel runs `git yunbox init --preset …`. YunBox can't list or create S3 buckets, so create a private bucket in the service's own console first. R2 tokens can be limited to buckets but not to prefixes, so use one bucket per project; see [R2 and S3-compatible storage](./r2). You can enter your Access Key ID and Secret Access Key in the same form, and they're saved on your Mac before connecting.
- **Saving keys**: when your Mac has no key for the repository's storage (the "COS 密钥" or "S3 密钥" check fails), the panel shows a form for it: the SecretId / SecretKey of your sub-account for COS, or the Access Key ID / Secret Access Key for S3. The SecretKey and Secret Access Key go in a secure field and reach `yunbox login` (`yunbox login --provider s3` for S3) only on standard input, never in command-line arguments or logs.
- **Push freeze in the menu bar**: the menu bar shows the YunBox mark, with a dot at the top right when the current repository is in a [push freeze](./freeze). Open the panel to see whether you can push now, today's timeline and the next 7 days' freeze windows. Global Rules (every repository on your Mac) and each project's rules are listed separately, and each can use presets such as Working hours or Weekends (picking one for a project also installs the pre-push wrapper if it's missing). Make Current switches to a project, Add Project… adds one that isn't listed, and Edit Push Freeze… lets you write custom rules. If the pre-push wrapper isn't installed, you can install it right there. The switch in the panel header turns every push freeze off at once (the rules are kept), or you can switch them off for 30 minutes, 1 hour or until the end of today, after which they come back on by themselves.
- **Asset types**: the Asset Types button next to the repository title shows and changes LFS rules by type. See [Asset Types](#asset-types) below.
- **Recent repositories**: up to 12; switch between the first 9 with `⌘1`–`⌘9`. When you switch, the last result shows first and is replaced once a fresh check finishes in the background.
- **Recently Blocked**: when the pre-push wrapper (`yunbox hook install`) blocks a push, because of a [push freeze](./freeze), an exceeded budget, or because you clicked Cancel in the confirmation dialog, it notes the repository on your Mac. Recently Blocked at the top of the sidebar lists up to 5 from the last 14 days with the reason and time; hover to see exactly which window or budget it was. Click one to open and check it, or right-click → Hide from List; it comes back the next time that repository is blocked. The record lives only on your Mac, in `~/.config/yunbox/blocked-pushes.json`, and holds just the repository path, the time and the reason: no remote URLs, no keys, and nothing written to the repository. If your command line sets `YUNBOX_CONFIG_DIR` or `XDG_CONFIG_HOME`, records go to that directory instead; an app opened from the Dock or Finder can't see your terminal's environment variables, so in that case the list stays empty.

## Asset Types

Next to the repository title you'll see "Asset types · 5 of 7 in LFS". If assets have been committed as ordinary files, it turns orange: "Asset types · N files not in LFS". Click it (or choose Inspect → Asset Types…) for the graphical version of `git yunbox types`:

- **Types**: Textures and images, Design source files, Models and animation, Audio, Video, Fonts and Archives. Each shows whether it's all in LFS, partly in LFS or not in LFS, how many files have been added to Git, and how many of those are LFS pointers. Expand a type to see whether each extension goes through LFS. Rules written by hand or added with `git lfs track` are marked Other rule, and the app never deletes them.
- **Add and remove**: Add appends the rules for that type (`git yunbox types add`); Remove… deletes the rules YunBox generated after you confirm (`git yunbox types remove`). Files already stored as LFS pointers aren't touched. The presets at the top (Game, Design, Images, audio and video, All types) add several types at once; a preset whose types are all in LFS already shows a check mark.
- **Assets committed as ordinary files**: grouped by reason: the extension is in a different case (such as `HERO.PNG` on Linux), the rule exists but the file was committed before it, or there is no rule at all. For the last two, Use LFS from the Next Commit… runs `git yunbox types add <type> --renormalize` after you confirm. It adds the rules and stages `.gitattributes` together with the files' current content, so from the next commit on they're stored as LFS pointers. Existing commits (history) stay as they are. Extensions in a different case need rules of their own; the panel shows the commands for that.

Every change goes only into `.gitattributes` and the staging area; nothing is committed. The command output appears at the bottom of the panel, and you commit when you're happy with it.

<p>
  <img src="../../guide/images/macos-asset-types-light.jpg" alt="The Asset Types panel (light, Chinese interface): presets, whether each type goes through LFS, and, expanded, each extension's rule source and file count" width="49%">
  <img src="../../guide/images/macos-asset-types-dark.jpg" alt="The Asset Types panel (dark, Chinese interface): assets committed as ordinary files, grouped by reason, and the Use LFS from the Next Commit button" width="49%">
</p>

Left: the presets and the list of types at the top of the panel; Audio's `*.wav` comes from a hand-written rule. Right: further down, the assets committed as ordinary files. (Screenshots show the Chinese interface.)

## Help and documentation

The Help menu opens the website's documentation directly, in the app's interface language. Help in the menu bar panel opens [Push freeze](./freeze), and the editing window and the Storage panel link to the matching pages too.

## Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| `⌘O` | Choose a repository |
| `⌘1`–`⌘9` | Switch to a recent repository |
| `⌘R` | Check again |
| `⌘.` | Cancel the check |
| `⇧⌘C` | Copy the full JSON |
| `⌘,` | Open Settings |

The range the window checks can differ from the refs the real pre-push hook receives, so the actual push is always checked again by the [push check hook](../inspect) against the real refs. For more detail, see the [app's README](../../../apps/macos/README.md).

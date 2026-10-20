# Changelog

The command-line tool (the `yunbox` npm package) and the macOS app share one version number. The notes for a new version also appear in the app's update prompt. [简体中文](../changelog)

## Unreleased

### Added

- The macOS app updates itself: it checks once a day in the background, or on demand from YunBox → Check for Updates…; updates and their notes are verified by signature.
- The macOS app is available in Simplified Chinese and English. Pick the language in Settings → Language, or follow the system.
- A changelog page, which the app opens from the Help menu and from Settings → Software Update.
- Push freeze: `yunbox freeze` sets weekly windows when pushing is not allowed (working hours, for example), and pre-push blocks pushes inside them. Rules can apply to one repository, the whole team, or every repository on the Mac.
- `yunbox freeze off` switches push freezes off for a while or until a given time, and they come back on by themselves.
- The macOS app shows in the menu bar whether the current repository can push, with today's and the next 7 days' freeze windows, one-click presets and a quick off switch.
- The macOS app's COS panel copies a setup prompt for AI coding assistants.
- A new guide, “Migrating from GitHub LFS” (in Chinese), shows how to move every past version of your assets from GitHub LFS or another LFS service to your own COS bucket, check the result, switch collaborators over and roll back.

## 0.1.4 - 2026-10-19

### Added

- The push confirmation previews the changed files, with a line-by-line diff for text files.
- The macOS app compares the selected file before and after the push, with unified and side-by-side text diffs.

## 0.1.3 - 2026-10-19

### Added

- A push over budget lists every file and asks you to confirm.
- The documentation is now a VitePress website with downloads.

### Changed

- Shared team settings moved to `.yunbox/config`; the old `.yunboxconfig` is still read, and `yunbox doctor` prints the command to move it.

## 0.1.2 - 2026-10-19

### Added

- `yunbox subaccount` creates long-term sub-account keys with only the permissions they need, and saves them on this machine, in one command.

## 0.1.1 - 2026-10-19

### Fixed

- `git yunbox init` exits normally when it has nothing to ask, instead of hanging the terminal.
- On Windows, git-lfs starts the transfer agent correctly, and `yunbox hook install` works.

## 0.1.0 - 2026-10-19

### Added

- First public release: Git LFS assets upload straight to your own Tencent Cloud COS, with no server in between.
- The `git yunbox init`, `doctor`, `status`, `login` and `policy` commands; on macOS, keys are kept in the keychain.
- A pre-push check of Git and LFS upload sizes.
- The macOS app: inspect push sizes, see the direct COS status and set it up from the window.

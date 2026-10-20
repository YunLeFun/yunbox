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
- `git yunbox types` manages LFS rules by asset type: it shows whether each type goes through LFS and how many files it has, and lists assets committed as ordinary files (including extensions in a different case on Linux, such as `HERO.PNG`). `add` adds types, with `--renormalize` to store already-committed files in LFS from the next commit on; `remove` deletes only the rules YunBox generated. `--json` is for graphical tools.
- Presets pick common sets of asset types at once: `game`, `design`, `media` and `all`, also accepted by `git yunbox init --types`.
- The macOS app has an Asset Types panel: see whether each kind of asset goes through LFS and how many files it has, add a preset in one click, add or remove single types, and move assets committed as ordinary files to LFS from the next commit on (after a confirmation; history stays as it is).
- The website is now available in English: the homepage, every guide and the push check reference, with a language switcher. The macOS app opens the English docs when its interface is in English.
- When pre-push blocks a push (a push freeze, an exceeded budget, or Cancel in the confirmation), YunBox notes on this Mac which repository it was, when and why. The macOS app's sidebar has a new Recently Blocked section that lists them; click one to open and check it.
- S3-compatible storage such as Cloudflare R2, AWS S3 and MinIO: connect a repository with `git yunbox init --preset r2` (or `aws`, `minio`, `--endpoint`) and save keys with `yunbox login --provider s3`; pushing, cloning, `doctor` and the push check work as they do with COS. R2 tokens can be limited to buckets but not to prefixes, so use one bucket per project; see the new guide on R2 and S3-compatible storage.
- A new guide, “Migrating from GitHub LFS”, shows how to move every past version of your assets from GitHub LFS or another LFS service to your own COS bucket, check the result, switch collaborators over and roll back.

### Changed

- The macOS app is notarized by Apple, so it opens the first time without a trip to Privacy & Security.
- The website and documentation are now available at [yunbox.yunle.fun](https://yunbox.yunle.fun/).
- Budgets in the macOS app are now edited as a number and a unit, with common values and Restore Default. After changing them you can check the current repository again right away, and when the app follows Git config it shows the budgets the last check actually used.
- In repositories connected directly to COS, the push check first asks COS which LFS assets are already there and budgets only what actually needs uploading, so a new branch is no longer flagged for assets the remote already has. If the lookup fails or times out, it counts every asset as before and never blocks the push.

### Fixed

- Fixed closed connections that prevented the website and documentation from opening on some networks.
- `git yunbox init` no longer adds LFS rules for file types that already have files committed outside LFS, so those files no longer show up as modified or break new clones. It lists them and shows the commands to move them to LFS.

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

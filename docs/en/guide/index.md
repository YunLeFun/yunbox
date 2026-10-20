# Quick start

YunBox lets git-lfs store your assets directly in your own Tencent Cloud COS bucket, or in S3-compatible storage such as Cloudflare R2, AWS S3 or MinIO. Your code stays on GitHub or wherever you host it. Large files such as PSDs, models, audio and video are signed by a transfer agent on each person's computer and uploaded straight to COS, **with no server in between**.

```
git push / clone ──▶ git-lfs ──▶ git-yunbox lfs-agent ──▶ Tencent Cloud COS
```

The transfer agent signs requests with the key saved on your machine and uploads to or downloads from COS directly.

This page walks through Tencent Cloud COS. Want Cloudflare R2 (no egress fees), AWS S3 or MinIO instead? See [Cloudflare R2 and S3-compatible storage](./r2).

::: tip Before you start
The command line prints its messages in Chinese for now; the commands, options and JSON output are the same in any language.
:::

## Install

```bash
npm install -g yunbox
```

You need Node.js 22.18+, Git 2.30+ and git-lfs 3.2+. Installing gives you two commands, `yunbox` and `git-yunbox`; `git yunbox <command>` and `yunbox <command>` do exactly the same thing.

If you'd like a graphical view of push sizes and connection status, also install the [macOS app](./macos).

::: tip Why everyone needs the command line
For security, git-lfs doesn't let a repository choose its transfer program through `.lfsconfig`. So the transfer agent can only be registered in each clone's own `.git/config`, which is what `git yunbox init` does.
:::

## Admins: connect the repository to COS

You only do this once, as an admin. If the repository already keeps its assets in GitHub LFS or a similar service, follow [Migrating from GitHub LFS](./migrate) instead.

```bash
tccli auth login             # sign in to Tencent Cloud in the browser; the temporary key lasts about 2 hours
git yunbox init              # pick a bucket or create a private one, enter a folder prefix; read/write is tested automatically
git add .gitattributes .yunbox/config
git commit -m "chore: store LFS assets in COS with YunBox"
git push
```

`git yunbox init` writes a `.gitattributes` with rules for each asset type (textures, design source files, models, audio, video, fonts and archives), and records the bucket, region and prefix in `.yunbox/config`. That file is committed so the whole team shares it. **It contains no keys.**

To see which types go through LFS, or to add and remove types later, use `git yunbox types`:

```bash
git yunbox types                 # whether each type uses LFS, its file count, and assets committed as ordinary files
git yunbox types add model,audio # presets work too: game, design, media, all
git yunbox types remove video    # removes only the rules YunBox generated; hand-written rules stay
```

Then switch yourself to a long-term key so you don't have to sign in again every two hours:

```bash
yunbox subaccount create --save   # a new sub-account limited to this prefix; its key goes into your local keychain
```

## Sub-accounts for collaborators

Still signed in as the admin:

```bash
yunbox subaccount create yunbox-alice --show-key              # create one and show its key once; hand it over through a secure channel
yunbox subaccount create yunbox-bob --show-key --read-only    # for people who only need to pull
yunbox subaccount list                                        # the sub-accounts YunBox created and their prefixes
yunbox subaccount delete yunbox-alice                         # someone leaves: delete the sub-account and the key stops working at once
```

Sub-accounts have programmatic access only. Their policy allows `PutObject`, `GetObject` and `HeadObject` on objects under this prefix (read-only ones lose `PutObject`). They can't list the bucket, can't delete anything, and can't touch other prefixes.

Once a collaborator has their key, they follow [Joining as a collaborator](./collaborators).

## When something goes wrong

```bash
yunbox doctor
```

It checks git, git-lfs, the transfer agent, your key and your read/write permissions one by one, and every failed check comes with the command that fixes it. Add `--json` for output other tools can read.

## Known limitations

- Without a server there are no file locks, so `lfs.locksverify` is set to `false`. Make sure only one person edits a given asset at a time.
- Teams that need to issue and revoke tokens centrally can use [server mode](/deploy) (in Chinese) instead.

For the full command reference, see the repository [README](../../../README.md).

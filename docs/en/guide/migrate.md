# Migrating from GitHub LFS

Your repository already stores assets in GitHub LFS (or GitLab, Gitea, a self-hosted LFS service, or YunBox server mode), and you want to connect it directly to your own COS bucket instead. The process: download every historical asset from the old service to your machine, switch the transfer agent, then upload everything to COS. You don't rewrite code history, and commit hashes stay the same.

One admin does the whole migration in a fresh clone. Everyone else switches over afterward on their own.

```
Old LFS service ──git lfs fetch --all──▶ local .git/lfs ──git lfs push --all──▶ Tencent Cloud COS
```

## Before you start

1. **Install the CLI**: `npm install -g yunbox`. You need Node.js 22.18+, Git 2.30+, and git-lfs 3.2+ (see [Quick start](./#install)).
2. **Get a bucket and keys ready**: The admin signs in with `tccli auth login`, and `git yunbox init` picks or creates a private bucket during the migration. Afterward, you can switch to long-lived sub-account keys with `yunbox subaccount create --save`. If you already have sub-account keys, save them with `yunbox login`. Sub-accounts can't list buckets, so pass `--bucket`, `--region`, and `--prefix` when you run `git yunbox init`.
3. **Create sub-accounts for collaborators**: `yunbox subaccount create <name> --show-key`. Add `--read-only` for people who only need to pull (see [Sub-accounts for collaborators](./#sub-accounts-for-collaborators)).
4. **Estimate space and time**: The migration downloads every historical asset and then uploads it all again. Check the total size first:

   ```bash
   git lfs ls-files --all --size
   ```

   Your local disk must have room for these objects, and COS bills you for the same amount of storage.
5. **Tell your team**: Ask everyone to push any assets they're working on before the switch. After the switch, they shouldn't push assets until they've set up YunBox themselves (see [How other collaborators switch](#how-other-collaborators-switch) for why).

## 1. Download all historical objects

Work in a **fresh clone**. All branches and tags from the old service come down as remote branches and tags:

```bash
git clone <repository-url> migrate-assets
cd migrate-assets
git lfs fetch --all
```

`git lfs fetch --all` downloads every LFS object referenced anywhere in the history of any branch or tag from the old service, and stores them in `.git/lfs/objects`. If the old service's remote isn't named `origin`, use `git lfs fetch --all <remote>`.

::: warning Do this before init
Once you run `git yunbox init`, git-lfs in this clone only downloads from COS, and COS is still empty. If you skipped this step, remove the transfer agent as described in [Rolling back](#rolling-back), run `git lfs fetch --all`, then run `git yunbox init` again.
:::

## 2. Switch to direct COS

```bash
git yunbox init                       # admin sign-in: pick or create a bucket, enter a prefix
git yunbox init --bucket <name-APPID> --region <region> --prefix <prefix>   # sub-account keys: specify them directly
```

The prefix defaults to `yunbox/<owner>/<repo>` (taken from the `origin` URL). `git yunbox init` first runs a read/write probe on that prefix with the keys on this machine, and only changes the repository if the probe passes. It then writes `.yunbox/config`, registers the transfer agent in this clone's `.git/config` (`lfs.standalonetransferagent=yunbox`), and sets `lfs.locksverify=false`.

### Check .gitattributes

`git yunbox init` merges YunBox's asset rules (textures, design source files, models, audio, video, fonts, archives) into your existing `.gitattributes`. Your existing rules stay as they are. If a type already has files committed as ordinary files (for example `.zip` files that were never managed by LFS), init doesn't add a rule for it and prints:

```text
! .gitattributes：这些类型已有文件作为普通文件提交过，没有为它们加 LFS 规则，否则这些文件会显示为已修改：*.zip（build/pack.zip）
```

This says some types already have files committed as ordinary files, so no LFS rules were added for them; otherwise those files would show up as modified.

That way, the migration only changes where assets are stored. It doesn't also change which files go through LFS. `git yunbox types` lists every asset committed as an ordinary file (including `HERO.PNG`, which `*.png` doesn't match on Linux). If you do want these files to use LFS from the next commit on (older versions in history stay unchanged), run what the message suggests:

```bash
git yunbox types add archive --renormalize   # add the *.zip rule and re-stage these files
git commit -m "chore: store archives in LFS"
```

You can also do this without YunBox commands: `git lfs track '*.zip'`, then `git add .gitattributes && git add --renormalize -- '*.zip'`.

Converting history to LFS as well requires rewriting it with `git lfs migrate import`, which this guide doesn't cover. To add only some types, use something like `git yunbox init --types model,audio`. To add none at all, run `git checkout -- .gitattributes` before you commit. To remove a type rule you've already committed, use `git yunbox types remove <type>`.

### When the old service is set in .lfsconfig

GitLab, Gitea, self-hosted services, and YunBox server mode usually set `lfs.url` in `.lfsconfig`. `git yunbox init` warns you:

```text
! lfs.url：.lfsconfig 里还有服务端模式的 lfs.url（…）；直连 COS 时不会用到它
```

This says `.lfsconfig` still has a server-mode `lfs.url`, and it isn't used when connected directly to COS.

Clones that have YunBox set up no longer use it, but **keep it** for now: collaborators who haven't switched yet keep using the old service, and you won't have to restore it if you roll back. Remove it once the old service is shut down (see [When can I shut down the old LFS service?](#when-can-i-shut-down-the-old-lfs-service)). GitHub LFS has no `lfs.url` (git-lfs derives the address from `origin`), so you can skip this section.

## 3. Upload all history

```bash
git lfs push --all origin $(git for-each-ref --format='%(refname)' refs/heads refs/remotes/origin refs/tags)
```

Run this in a macOS or Linux terminal, or in Git Bash. `git lfs push` needs a remote name (here, `origin`), but the transfer agent doesn't connect to the remote's address. Objects go straight to the COS location set in `.yunbox/config`.

::: warning List your branches and tags
With just `git lfs push --all origin`, git-lfs only looks at local branches and tags. In a fresh clone, the default branch is the only local branch. Every other branch exists only under `refs/remotes/origin/`, so assets unique to those branches would be missed. The command above lists local branches, remote branches, and tags.
:::

Before uploading, the transfer agent checks whether COS already has each object and skips the ones it does. You can safely rerun this command.

## 4. Commit and push

Once all historical assets are in COS, commit the configuration:

```bash
git add .gitattributes .yunbox/config
git commit -m "chore: store LFS assets in COS with YunBox"
git push
```

Don't reverse the order. If you push this commit before uploading history, the first collaborators to switch will hit old assets that aren't in COS yet.

## 5. Verify

In the migration clone:

```bash
yunbox doctor
```

Once every check passes, **use a fresh directory** to clone the repository the way a collaborator would, and download the full history from COS:

```bash
cd ..
git yunbox clone <repository-url> verify-assets
cd verify-assets
git lfs fetch --all
git lfs fsck
```

If `git lfs fetch --all` finishes without errors, every object referenced by every branch and tag can be downloaded from COS, and its size and SHA-256 have been checked. If `git lfs fsck` prints `Git LFS fsck OK`, the pointers and objects in the current version match. You can also `git checkout` a few old tags or branches and open some assets to check them.

## How other collaborators switch

The switch only applies to clones that have run `git yunbox init`. A clone that pulls the migration commit but hasn't run init **still connects to the old service**, and any assets it pushes go to the old service, not COS. So ask everyone to switch as soon as possible:

```bash
yunbox login          # save the sub-account keys from the admin
git pull
git yunbox init && git lfs pull
yunbox doctor         # with read-only access, use yunbox doctor --read-only
```

In a clone that hasn't run init yet, `yunbox doctor` reports an error on the transfer agent check and suggests `git yunbox init`.

Anyone who pushed new assets to the old service before switching should upload them again from their own clone after init, because those objects only exist on their machine:

```bash
git lfs push --all origin $(git for-each-ref --format='%(refname)' refs/heads refs/remotes/origin refs/tags)
```

New team members just run `git yunbox clone <repository-url>`. See [Joining as a collaborator](./collaborators).

CI pipelines that pull assets from the old service (for example `actions/checkout` with `lfs: true`) need updating too. Install the YunBox CLI, set the `TENCENTCLOUD_SECRETID` and `TENCENTCLOUD_SECRETKEY` environment variables to a read-only sub-account's keys, then run `git yunbox init --read-only && git lfs pull`.

## Rolling back

The migration never deletes objects from the old service. As long as the old service is still around, you can go back at any time.

**Switch one clone back to the old service**: Remove the transfer agent, and git-lfs goes back to the original LFS address:

```bash
git config --local --unset lfs.standalonetransferagent
git config --local --remove-section lfs.customtransfer.yunbox
git config --local --unset lfs.locksverify   # optional: restore lock checks if the old service supports file locking
```

**Undo the migration for the whole repository**: Assets pushed after the switch only exist in COS, so send them back to the old service first. In a clone that has YunBox set up:

```bash
git lfs fetch --all                              # first download every object from COS
git config --local --unset lfs.standalonetransferagent
git config --local --remove-section lfs.customtransfer.yunbox
git lfs push --all origin $(git for-each-ref --format='%(refname)' refs/heads refs/remotes/origin refs/tags)
git rm -r .yunbox
git commit -m "chore: move assets back to the original LFS service"
git push
```

Then ask each collaborator to run the two commands from "Switch one clone back" above in their own clone. Once `.yunbox/config` is gone from the repository, any clone that still has the transfer agent fails on push and pull with 「仓库里没有 .yunbox/config」 (".yunbox/config is missing from the repository"), which is a handy reminder to clean up. Objects in COS aren't deleted automatically, and sub-accounts don't have delete permission. If needed, the admin can clean up this prefix in the COS console.

## FAQ

### How long does a large repository take?

Most of the time goes into downloading and then uploading the full history. Roughly: total size ÷ download bandwidth + total size ÷ upload bandwidth to COS. Run it on a machine with a good connection and plenty of disk, ideally a cloud server in the same region as the bucket. git-lfs transfers 8 objects at a time by default. If you have many small files, raise this:

```bash
git config lfs.concurrenttransfers 16
```

### What if it gets interrupted?

You can simply rerun either step. `git lfs fetch --all` skips objects you already have locally. During `git lfs push --all`, the transfer agent checks COS first and skips objects that are already uploaded, so nothing is uploaded twice or overwritten. The git-lfs progress bar still counts skipped objects, so it looks like everything is being uploaded again. That's expected. If an upload is cut off partway through an object, COS doesn't keep a partial object, and the rerun uploads it again.

### Some objects are missing from the old service

`git lfs fetch --all` reports errors when it tries to download these objects. Later, `git lfs push --all` lists the objects missing locally as `(missing) <path> (<oid>)` and exits with a failure, while still uploading everything else. First, see whether you can recover them from someone else's clone: set up YunBox in their clone and run the `git lfs push --all` command above to upload them. If they really can't be recovered, you can tell git-lfs to skip missing objects:

```bash
git config lfs.allowincompletepush true
git lfs push --all origin $(git for-each-ref --format='%(refname)' refs/heads refs/remotes/origin refs/tags)
git config --unset lfs.allowincompletepush
```

The old versions that use these objects can never be restored.

### When can I shut down the old LFS service?

Once all of the following are true:

- A fresh `git yunbox clone` plus `git lfs fetch --all` in a new directory passes.
- All collaborators and CI have switched (each passes `yunbox doctor`), and you've confirmed nobody pushes to the old service anymore.
- You've waited a while (for example a week or two) and no longer need to [roll back](#rolling-back).

After shutting it down, remove the old service's address from `.lfsconfig` and commit (GitHub LFS doesn't need this step):

```bash
git config --file .lfsconfig --unset lfs.url
git add .lfsconfig            # if .lfsconfig is now empty, use git rm .lfsconfig instead
git commit -m "chore: remove the old LFS service address"
```

GitHub LFS storage and bandwidth are billed under GitHub's rules. Follow GitHub's documentation for how to clean up existing objects. Assets pushed after the migration aren't in GitHub LFS, so you can't see their contents on the GitHub website.

::: tip How this guide was tested
We ran the steps above locally (git 2.55, git-lfs 3.7.1). The old service was stood in for by a local bare repository's built-in LFS storage and by YunBox server mode (with `lfs.url` in `.lfsconfig`). COS was the stand-in COS used by the repository's tests. We verified multiple branches, tags, repeat uploads not writing objects twice, missing objects, collaborators uploading their own assets, and rolling back. We haven't run it against real GitHub LFS or real COS. If anything differs from this guide, please [open an issue](https://github.com/YunLeFun/yunbox/issues).
:::

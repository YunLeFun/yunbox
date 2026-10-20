# Joining as a collaborator

Your admin has already connected the repository to COS and given you a sub-account key (a SecretId and a SecretKey).

## 1. Install the command line

```bash
npm install -g yunbox
```

You need Node.js 22.18+, Git 2.30+ and git-lfs 3.2+. On Windows, use the git-lfs that comes with Git for Windows.

## 2. Save your key

```bash
yunbox login
```

The SecretKey is hidden as you type, and it can't be passed as a command-line argument, so it never ends up in your shell history.

- On macOS it's stored in your login keychain, under the item "yunbox".
- On Linux and Windows it's stored in `~/.config/yunbox/credentials.json` (`%APPDATA%\yunbox` on Windows), readable only by you.

When you no longer need it, run `yunbox logout` to delete it from the keychain and the file.

## 3. Clone the repository

```bash
git yunbox clone <repository-url>
```

This clones the code history, runs `git yunbox init` to hook up the transfer agent, then runs `git lfs pull` to download the assets.

If you've already cloned the repository, run this inside it instead:

```bash
git yunbox init && git lfs pull
```

## 4. Work as usual

From now on it's the usual `git add`, `git commit`, `git push` and `git pull`. git-lfs hands assets to YunBox's transfer agent, which uploads them to COS or downloads them from it directly. Downloads are checked against their size and SHA-256, so a damaged object never lands in your working tree.

If a push or pull fails, start with:

```bash
yunbox doctor
```

If you only have read access, use `yunbox doctor --read-only`.

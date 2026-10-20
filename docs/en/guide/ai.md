# Set up with an AI coding assistant

Every YunBox command can run without prompts and print JSON, so you can hand the setup to a coding assistant such as Claude Code, Codex or Cursor and let it work through the steps. Only one thing stays with you: **saving your Tencent Cloud key**. Don't send your SecretId or SecretKey to the AI, and don't let it put them in command-line arguments or files.

## Copy it from the app

In the [macOS app](./macos), the Storage panel (click the storage status next to the repository title) has **Copy Setup Prompt for AI**. It builds a prompt for the repository's storage (Tencent Cloud COS, or S3-compatible storage such as R2; before the repository is connected, the storage chosen in the panel) that includes:

- the repository path and the current check results (connected, what needs attention, or not connected);
- the path to the CLI bundled with the app, so it works even if `yunbox` isn't installed in your terminal;
- the steps and safety rules below.

Paste it into your coding assistant and you're done.

## Write the prompt yourself

Without the app, send something like this to your coding assistant, with your own repository path:

```text
Please connect this Git repository to YunBox (Git LFS assets uploaded straight to my own Tencent Cloud COS) and install the push check.
Repository: /path/to/repo

Work through these steps in order, and read each JSON result before deciding the next step:
1. Run `yunbox doctor --json` to see the current state; for options you're unsure about, see `git yunbox init --help`.
2. If the COS key is missing: stop and ask me to run `yunbox login` myself. Don't ask me for the key, and never put it in a command line, a file or the repository.
3. Run `yunbox buckets --json` and confirm the bucket and folder prefix with me; ask me before creating a new bucket.
4. Run `git yunbox init --bucket <name-APPID> --region <region> --prefix <prefix> --yes`.
5. Run `yunbox doctor --json` again and make sure nothing fails.
6. Run `yunbox hook install`.
7. Ask me whether I want push freeze windows; if so, use `yunbox freeze set "Mo-Fr 09:00-18:00"` and check with `yunbox freeze check --json`.
8. Show me the changes to .gitattributes and .yunbox/config and let me decide whether to commit; don't git push.
```

If the repository uses Cloudflare R2 or another S3-compatible service, replace steps 3 and 4 with: "Confirm the bucket and endpoint with me, then connect with `--preset r2` (or `aws`, `minio`) as described in `git yunbox init --help`." You save the key yourself with `yunbox login --provider s3`; see [Cloudflare R2 and S3-compatible storage](./r2).

If your terminal doesn't have the `yunbox` command yet, run `npm install -g yunbox` first (it needs Node.js 22.18+).

The CLI's human-readable messages are in Chinese for now, but JSON field names and status values (such as `ok`, `fail` and `frozen`) are in English, and coding assistants read the rest fine.

## Commands you can hand to AI

| Command | Output | Use |
| --- | --- | --- |
| `yunbox doctor --json` | each check and its fix command | see the current state, verify the result |
| `yunbox buckets --json` | the buckets your local key can see | choose a bucket |
| `git yunbox init --bucket … --region … --prefix … --yes` | text | connect without any questions |
| `yunbox hook install` | text | install the pre-push check |
| `yunbox inspect --push --json` | [size report](../inspect#json-output) | check before pushing |
| `yunbox freeze set / list --json / check --json / off / on` | [push freeze](./freeze) | set, view and temporarily switch off push freeze windows |

`yunbox login` also accepts `--secret-key-stdin`, but run it yourself; don't let the AI pass your key along.

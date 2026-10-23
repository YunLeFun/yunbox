# Frequently asked questions

## Where assets are stored

::: details Does pushing upload one copy to GitHub LFS and another to COS?
Once YunBox direct mode is configured, it does not. `git push` sends code, commits and LFS pointers to your Git remote. git-lfs hands the asset content to YunBox, which uploads it directly to the configured COS or S3-compatible storage. An object already present at the same storage location with the expected size is skipped.

```text
git push
├─ Code, commits, LFS pointers → GitHub / GitLab / another Git remote
└─ LFS asset content → YunBox transfer agent → COS / S3
```

Assets previously uploaded to the old LFS service are not deleted automatically. Both services may retain copies during migration. See the [migration guide](./migrate).
:::

::: details Why is a collaborator still accessing GitHub LFS?
The transfer agent is registered in each clone's local Git configuration, which is not shared through commits. Having `.yunbox/config` alone is not enough. Each collaborator must install the CLI, save their own keys and connect their clone:

```bash
npm install -g yunbox
yunbox login
git yunbox clone <repository-url>
```

For an existing clone, run `git yunbox init` inside it, then `git lfs pull`. For S3-compatible storage, use `yunbox login --provider s3`. See [Joining as a collaborator](./collaborators).
:::

::: details What does status show? Does “registered” mean I can upload?
`yunbox status` shows the code and asset destinations, whether the direct transfer agent is registered, and local LFS file counts and sizes. Direct COS / S3 mode does not require `lfs.url`. If the agent is missing, status suggests running `git yunbox init` for this clone.

It reads only local configuration and files, without checking keys, network access or cloud usage. “Registered” does not mean remote permissions have been verified. Use `yunbox doctor` for a full check, or `yunbox doctor --read-only` for read-only collaborators.
:::

## Working without a graphical client

::: details How do I use YunBox on Windows / Linux?
Use Node.js, Git, git-lfs and the `yunbox` CLI; the macOS app is not required. After setup, continue using `git add`, `git commit`, `git push` and `git pull`. git-lfs displays transfer progress. On Windows, use the git-lfs bundled with Git for Windows.

Run `yunbox inspect --push` before pushing. To check every push and ask for confirmation when over budget, run inside your repository:

```bash
yunbox hook install --confirm
git config yunbox.confirmUI terminal
```

Windows reads the answer from its attached console (for example PowerShell / Windows Terminal); Linux uses the controlling terminal. Return cancels by default; `y` continues and `n` cancels. You can add a reason, such as `n compress the images first`. Git Bash needs an attached Windows console. A GUI or terminal environment without one cannot ask; the push is cancelled, and you should retry in PowerShell / Windows Terminal.
:::

::: details Can macOS switch between graphical confirmation and the terminal?
Yes. The default `auto` mode shows a native confirmation window on a local Mac, with a button to open full details in the installed YunBox app. The window also works without the app. SSH sessions use the terminal.

```bash
# Always use the terminal in this repository, including pre-push checks
git config yunbox.confirmUI terminal

# Restore automatic selection; use dialog to request the graphical window
git config yunbox.confirmUI auto

# Override only this manual check
yunbox inspect --push --confirm --confirm-ui terminal
```

Add `--global` after `git config` to set your preference for all repositories. Precedence: `--confirm-ui` > `YUNBOX_CONFIRM_UI` environment variable > `yunbox.confirmUI` Git setting > `auto`. `none` skips the question and cancels over-budget pushes. None of these modes override a push freeze.
:::

::: details Why is there no confirmation in CI or a GUI?
Terminal confirmation needs a real controlling terminal. Git pre-push supplies ref updates on standard input, so that input cannot be treated as an answer. Without a graphical window or controlling terminal, YunBox cancels the push with an explanation; it never assumes approval. Address the over-budget files, then retry from an interactive terminal. For scripts, use `yunbox inspect --push --json` and handle its exit code.
:::

## Reading the terminal report

::: details How do candidate bytes, upload bytes and existing objects differ?
“Git upload” estimates the compressed pack. “LFS candidates” counts assets referenced by the outgoing history. After a successful storage lookup, the report shows LFS upload bytes and existing objects, which will be skipped. If the remote cannot be checked, upload size is shown as unknown, never zero. File rows show raw sizes; Git compression and delta transfers may reduce actual traffic.

See [Push size check](../inspect) for the full definitions and JSON fields. CLI messages are currently in Chinese.
:::

::: details What do the colors mean, and can I disable them?
Green means passed, yellow means a warning or pending confirmation, red means failed or over budget, and cyan highlights destinations and upload information. Status words and symbols remain meaningful without color.

Interactive terminals use color automatically. Pipes, redirected output, CI, `TERM=dumb` and JSON remain plain. To disable colors:

```bash
# macOS / Linux / Git Bash, for one command
NO_COLOR=1 yunbox inspect --push
```

```powershell
# PowerShell, for this session
$env:NO_COLOR = '1'
yunbox inspect --push
Remove-Item Env:NO_COLOR
```
:::

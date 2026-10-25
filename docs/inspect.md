# 推送体积检查

`yunbox inspect` 检查已提交的 Git 内容和 LFS 指针，不上传文件、不改写历史，也不要求配置 YunBox 服务或安装 git-lfs。未提交的构建目录不在统计范围内。

希望使用窗口操作时，可安装 [macOS 原生客户端](../apps/macos/README.md)，它复用以下 JSON 接口，支持仓库选择、文件筛选和报告复制。

```bash
yunbox inspect --push
yunbox inspect --push --base origin/main --head HEAD --json
yunbox inspect --push --git-limit 900k --lfs-limit 100m --file-limit 10m --top 20
yunbox inspect --push --confirm   # 超限时按平台和设置选择确认方式
yunbox inspect --push --confirm --confirm-ui terminal   # 这次只用终端
```

默认比较 HEAD 与本地 upstream 快照；没有 upstream 时检查 HEAD 的全部历史并提示。`--stdin` 接受 Git pre-push 的四列引用更新，支持多分支和删除，不能与 `--base` / `--head` 合用。只有显式提供 `--remote <name/url>` 才会在新分支或缺少旧 tip 时查询远端 Git refs；查询失败或远端对象不在本地时保守估算。不会 fetch 或下载 LFS 内容；直连 COS 的仓库会查询 LFS 对象是否已上传，见下文。

## 终端报告

文本报告先显示代码目标和素材目标，再列出上传预算和变更文件。COS / S3 已接入时明确标识直连；只提交了存储配置、当前 clone 还没登记代理时会提示运行 `git yunbox init`。`yunbox status` 使用相同的目标展示，并列出本地素材用量；它不访问网络，也不检查密钥。

交互终端用绿色表示通过、黄色表示提醒、红色表示失败或超限。重定向、管道、CI 和 JSON 不含颜色转义；`NO_COLOR=1` 可关闭颜色。跨平台设置与使用示例见[常见问题](./guide/faq)。

## 统计口径

- **Git pack**：本地 thin-pack 估算，包括提交、目录、普通文件及 LFS 指针。计数超过 `max(10 MiB, Git 限额)` 时停止，报告下界而非精确值；不包含协议握手开销。
- **Git 文件明细**：普通 blob 的原始大小，不含识别出的 LFS 指针。同一内容按对象 ID 去重，不同历史版本分别统计，包括后来已删除的大文件。原始大小不等于压缩、增量后的网络上传量。
- **LFS 候选量**：从推送历史的指针读取素材大小，按 LFS SHA-256 去重。新分支保留完整历史候选，即使 Git pack 可排除远端其他分支已有的对象。
- **LFS 实际上传量**：仓库[直连 COS](./guide/) 且本机有密钥（`yunbox login`、`TENCENTCLOUD_*` 或 `tccli auth login`）时，对每个候选向 COS 发一次 HEAD（和传输代理上传前的检查相同，只需 `HeadObject` 权限），已存在且大小一致的不计入上传量，`uploadBytes` 给出确定值；LFS 预算、单文件预算和变更文件的上传大小都只按需要上传的对象计算。查询最多同时 8 个请求、总共 5 秒；任一请求失败（无权限、网络错误）或超时，整次查询作废，按原来的方式只给候选量，并在提示里说明原因，不会阻止推送，也不会把查不到当作已上传。环境变量 `YUNBOX_INSPECT_REMOTE_TIMEOUT_MS` 可以调整时限，`0` 关闭查询。使用 YunBox 服务端（`lfs.url`）或未接入的仓库不查询，实际上传量未知。
- **变更文件**：按路径汇总推送提交中的改动，类似 `git diff --stat` 加上大小：状态（新增、修改、删除，以及「临时」：在本次提交中新增后又删除，内容仍会上传）、推送前后的大小（LFS 为素材大小）、本次上传的版本数和原始大小合计。按本次上传大小降序；同一内容被多个路径使用时每个路径都计入。前后状态取最早和最新一次改动，多分支推送时为近似值。
- **单文件限额**：同时适用于普通 Git 文件和 LFS 素材。文本显示前 10 个变更文件（`--top` 可调至 100）；JSON 包含所有变更、对象、已找到的路径、精确字节数和超限标记。路径未知的对象单独列出对象 ID。

默认预算是 Git pack **900 KiB**、LFS 候选总量 **100 MiB**、单文件 **10 MiB**。这些是本地检查预算，不是托管平台配额。任一项超过预算都会返回超限；等于预算时通过。命令行参数优先于仓库/全局 Git 配置：

```bash
git config yunbox.inspectGitBytes 900k
git config yunbox.inspectLfsBytes 100m
git config yunbox.inspectFileBytes 10m
```

支持整数字节及 `k/m/g`、`KiB/MiB/GiB`，均为 1024 进制。退出码：`0` 未超限，`1` 超限，`2` 检查失败。缺失对象、无效指针、超时或分析输出过大均返回失败，不能视为零流量。

## JSON 接口

`--json` 的 stdout 只有一个 JSON 对象，包括错误情况；`--help` 仍输出帮助文本。`schemaVersion` 当前为 `1`，可供后续 Craft Hub 或 CI 接入。

| 字段 | 含义 |
| --- | --- |
| `status` | `ok`、`exceeded` 或 `error` |
| `limits` | `gitBytes`、`lfsBytes`、`fileBytes` |
| `git.packBytes` / `packComplete` | 完整估算值；不完整时 `packBytes` 为 `packCapBytes + 1`，代表下界 |
| `git.blobBytes` / `blobCount` / `pointerBytes` | Git blob 原始大小与数量（含指针），以及其中指针的大小 |
| `git.exceedsLimit` / `lfs.exceedsLimit` | 各自总量是否超过预算；单文件超限另见每条明细 |
| `changes` | 每个变更路径一条：`{ path, status, storage, beforeBytes, afterBytes, beforeOid, afterOid, versions, pushBytes, exceedsFileLimit }`。`status` 为 `added`、`modified`、`deleted` 或 `transient`；`storage` 为 `git` 或 `lfs`；路径不存在或旧对象不在本地时大小为 `null`；`versions` 为 `0` 表示没有新内容需要上传（如删除，或 LFS 对象已在 COS）。新增字段，`schemaVersion` 仍为 `1` |
| `changes[].beforeOid` / `afterOid` | 推送前、推送后的内容 ID，用于读取对应版本：LFS 文件为素材的 SHA-256（本地位于 `.git/lfs/objects/<前 2 位>/<3–4 位>/<oid>`，可能尚未下载），普通文件为 Git blob ID（`git cat-file blob <oid>`）。与对应的大小同时为 `null`。不要从工作区读取，工作区可能与推送的提交不同。新增字段，`schemaVersion` 仍为 `1` |
| `git.files` / `lfs.files` | 完整对象列表，每条为 `{ oid, bytes, paths, exceedsFileLimit }`，按大小降序。`exceedsFileLimit` 表示超过单文件预算且需要上传，COS 上已有的 LFS 对象为 `false` |
| `lfs.files[].onRemote` | 仅在 `lfs.remoteChecked` 为 `true` 时提供：存储上是否已有这个对象（推送时跳过）。新增字段，`schemaVersion` 仍为 `1` |
| `lfs.candidateBytes` / `candidateCount` | 去重后的 LFS 候选大小和数量 |
| `lfs.remoteChecked` / `uploadBytes` | 查询了存储时为 `true` / 需要上传的 LFS 字节数；否则为 `false` / `null`，不能把未知上传量当成 `0`。`lfs.exceedsLimit` 在已查询时按 `uploadBytes` 判断，否则按 `candidateBytes` |
| `lfs.remoteStorage` | 仅在 `lfs.remoteChecked` 为 `true` 时提供：查询的是哪种存储（`COS`、`S3`）。新增字段，`schemaVersion` 仍为 `1`；没有这个字段的旧版本只查询 COS |
| `warnings` | 保守估算、upstream 快照等提示 |
| `error` | 仅失败时提供 `{ code: "INSPECTION_FAILED", message }`，不返回原始 Git 错误或远端 URL |

## 超限确认

`--confirm` 在超限时询问是否继续：确认后退出码为 `0`，取消或无人可问时为 `1`。不能与 `--json` 合用。

- **macOS**：弹出原生对话框（通过 `osascript` 运行，无需安装应用）。标题写明推送目标（如 `github.com/owner/repo`，不含凭据），下面一行是本地仓库名和推送的分支。按钮行可以在 Finder 中显示仓库、用已安装的编辑器（Cursor、VS Code、Zed 或 Sublime Text）打开、在 YunBox 客户端中查看完整信息（已安装时），或在浏览器中打开远端仓库页面，每个按钮带有它所打开应用的图标；这些按钮不会关闭对话框。再往下是 Git pack、LFS 候选、最大单文件三项预算的用量条，以及逐个文件的表格：状态、目录与文件名、推送前后大小及差值、版本数和本次上传大小条，超限文件标红。点击推送后仍存在的文件，用「快速查看」预览推送的版本：修改的文件同时打开推送前和推送后两个版本，用左右方向键切换，新增的文件只显示新版本；修改过的普通 Git 文本文件（每个版本不超过 1 MiB）还多一页带两侧行号、红绿着色的逐行差异，点击文件后先显示推送后的版本，差异生成完成后自动显示这一页；如果已经切到旧版本，则保持当前页。差异仅按需生成，重复查看复用结果，和报告页一样不含脚本；预览不会关闭对话框，点预览窗口的关闭按钮或按 Esc 关闭预览；预览打开时在对话框里按 Esc 也只关闭预览，不会取消推送。预览内容取自 Git 对象或本地 LFS 存储（`.git/lfs/objects`），而不是工作区，因为工作区可能与推送的提交不同；它们复制到仅当前用户可读的临时目录，对话框关闭时删除。本地没有的 LFS 旧版本无法预览。报告页面不含脚本，内容安全策略仍为 `default-src 'none'`。文件很多时只有表格滚动，用量条和表头保持不动。表格下方有一个「原因（可选）」输入框，对话框打开时光标就在里面：写一句为什么取消或继续推送，再点任一按钮即可，不写也行。原因会出现在推送的输出里，告诉发起推送的人或 AI 编程助手；取消或确认继续时也会记入本机推送保护历史。确认框先显示推送目标、超限原因和操作按钮，再加载文件列表，列表加载期间也可以取消或继续。默认按钮为「取消」，按回车即取消；没有打开预览时，按 Esc 或关闭确认窗口也会取消推送。对话框最多列出 300 个文件，其余见 `--json`。
- **Windows / Linux / 纯终端 macOS**：通过控制终端询问 `[y/N]`，Windows 使用附带的控制台，macOS / Linux 使用 `/dev/tty`，不读取 pre-push 的标准输入。原因可以写在回答后面，例如 `n 先压缩图片` 或 `y 美术已确认`。按回车取消，SSH 默认使用终端。Windows 推荐在 PowerShell / Windows Terminal 中运行；Git Bash 需要附带可用的 Windows 控制台。
- **无法询问**（无窗口或无控制终端）：阻止推送并提示，不会自动同意。

取消推送时，输出会写明原因（如果填了），并提醒不要提高限额或用 `--no-verify` 绕过检查，这样从 AI 编程助手发起的推送也能知道下一步该做什么。

确认方式可选 `auto`、`dialog`、`terminal` 或 `none`（不询问，超限时直接阻止）。优先级为 `--confirm-ui` > `YUNBOX_CONFIRM_UI` > Git 配置 `yunbox.confirmUI` > `auto`。`--confirm-ui` 必须与 `--confirm` 一起使用。保存偏好后，带 `--confirm` 的 pre-push 包装层也会采用：

```bash
git config yunbox.confirmUI terminal          # 当前仓库纯终端
git config --global yunbox.confirmUI terminal # 所有仓库默认纯终端
git config yunbox.confirmUI auto              # 当前仓库恢复自动选择
```

macOS 的 `auto` 在本机使用原生窗口，可以从窗口中打开 YunBox 客户端；SSH 使用终端。显式 `dialog` 会尝试打开原生窗口，无法打开时尝试终端。

## 本机推送保护历史

钩子遇到禁推、超限阻止、用户取消或用户确认继续时，都会按项目追加记录时间、原因、处理结果和填写的说明；手动检查不记历史。「确认继续」表示检查放行，实际上传结果由 Git 返回。

历史只保存在用户电脑的 `~/.config/yunbox/push-history.json`（可由 `YUNBOX_CONFIG_DIR` 或 `XDG_CONFIG_HOME` 指定目录），不会提交进仓库。默认保留最近 90 天，每项目最多 200 条，全部最多 5000 条。旧版最近一次记录会迁入。macOS 客户端可在「推送保护历史」窗口筛选项目、查看与清理。

```bash
yunbox history                      # 当前项目
yunbox history --all --json         # 本机全部项目
yunbox history clear --yes          # 清理当前项目
yunbox history clear --all --yes    # 清理全部本机历史
```

清理会同时移除对应旧版最近拦截记录，避免再次出现；不会修改钩子、Git 配置、素材或密钥。历史清理后无法恢复。

## 禁推时段

`yunbox freeze` 设置不允许推送的时段（例如工作时间、发版冻结），处在时段内时 pre-push 直接中断推送，`--confirm` 也不能放行；`yunbox freeze off` 可以临时关闭。写法、团队共享、快速关闭和 JSON 接口见[禁推时段](./guide/freeze)。

## 在上传前执行

仅注册多个独立的 `pre-push` 钩子不能保证失败后停止：Git 仍可能执行后面的 LFS 上传钩子。先运行 `git lfs install --local`（使用 LFS 时），再安装串行包装层：

```bash
yunbox hook install
# 默认超限询问；如需超限直接阻止：
yunbox hook install --no-confirm
# 使用 Workstation 的 macOS 对话框/终端确认，而非直接阻止超限推送：
yunbox hook install --guard ~/.local/libexec/git-confirm-large-push
# 恢复原钩子：
yunbox hook uninstall
```

默认包装层调用当前安装的 YunBox CLI，超限时询问是否继续；取消或无人确认时退出。关闭 App 后仍然生效，`--confirm` 是默认行为的显式写法。`--guard` 接受绝对路径可执行文件，以它的退出码决定是否执行原钩子；Workstation 适配器仅检查 GitHub remote。原钩子保留为 `pre-push.yunbox-original`，参数和 stdin 原样传递；重复安装不会重复套娃，卸载恢复原文件。发现用户修改过包装层、自定义 `core.hooksPath`、符号链接或未登记的备份时拒绝覆盖。自定义钩子管理器需自行串行接入。移动/卸载 CLI 或 guard 后需重新安装包装层。

包装层只控制它保存的仓库钩子；其他独立 configured hooks 若也上传素材，仍需由它们自己的管理器串联。安装后再次执行 `git lfs install` 可能提示已有钩子；需要更新 LFS 钩子时先卸载包装层，更新后再安装。`git push --no-verify` 会绕过 pre-push 检查。

## 可选的全局保护

```bash
yunbox hook install --global       # 所有未自定义钩子目录的仓库，默认超限询问
yunbox hook status --json          # 当前仓库实际生效的范围、确认方式和环境状态
yunbox hook uninstall --global     # 恢复使用各仓库原有的钩子
```

全局模式设置 Git 的 `core.hooksPath`，串行执行检查及仓库原有的 pre-push，并转发其他标准 Git 钩子（包括 LFS checkout 钩子）。已有全局或系统级钩子目录时拒绝覆盖；仓库的自定义目录优先于全局设置。已有 YunBox 仓库包装层会优先执行，避免重复检查，保留原来的确认方式。独立配置的上传钩子仍需由其管理器保证顺序。

`git yunbox init` 默认安装本仓库的保护，交互终端会询问是否启用；`--yes` 或非交互运行采用默认值。`init --no-hook` 只配置存储，`init --global-hook` 显式选择全局保护；这两个选项不能合用。重复初始化会保留已安装的保护和原有 LFS 钩子。使用全局模式后，请通过 `yunbox init` 配置 LFS；直接运行 `git lfs install` 可能因共享目录中已有包装层而报错。

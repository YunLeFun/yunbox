# 推送体积检查

`yunbox inspect` 检查已提交的 Git 内容和 LFS 指针，不上传文件、不改写历史，也不要求配置 YunBox 服务或安装 git-lfs。未提交的构建目录不在统计范围内。

希望使用窗口操作时，可安装 [macOS 原生客户端](../apps/macos/README.md)，它复用以下 JSON 接口，支持仓库选择、文件筛选和报告复制。

```bash
yunbox inspect --push
yunbox inspect --push --base origin/main --head HEAD --json
yunbox inspect --push --git-limit 900k --lfs-limit 100m --file-limit 10m --top 20
```

默认比较 HEAD 与本地 upstream 快照；没有 upstream 时检查 HEAD 的全部历史并提示。`--stdin` 接受 Git pre-push 的四列引用更新，支持多分支和删除，不能与 `--base` / `--head` 合用。只有显式提供 `--remote <name/url>` 才会在新分支或缺少旧 tip 时查询远端 Git refs；查询失败或远端对象不在本地时保守估算。不会 fetch 或下载 LFS 内容。

## 统计口径

- **Git pack**：本地 thin-pack 估算，包括提交、目录、普通文件及 LFS 指针。计数超过 `max(10 MiB, Git 限额)` 时停止，报告下界而非精确值；不包含协议握手开销。
- **Git 文件明细**：普通 blob 的原始大小，不含识别出的 LFS 指针。同一内容按对象 ID 去重，不同历史版本分别统计，包括后来已删除的大文件。原始大小不等于压缩、增量后的网络上传量。
- **LFS 候选量**：从推送历史的指针读取素材大小，按 LFS SHA-256 去重。新分支保留完整历史候选，即使 Git pack 可排除远端其他分支已有的对象。尚不查询 LFS Batch API，远端可能已有部分对象，实际上传量未知。
- **单文件限额**：同时适用于普通 Git 文件和 LFS 素材。文本各显示前 10 个对象（`--top` 可调至 100）；JSON 包含所有对象、已找到的路径、精确字节数和超限标记。路径未知时保留对象 ID。

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
| `git.files` / `lfs.files` | 完整对象列表，每条为 `{ oid, bytes, paths, exceedsFileLimit }`，按大小降序 |
| `lfs.candidateBytes` / `candidateCount` | 去重后的 LFS 候选大小和数量 |
| `lfs.remoteChecked` / `uploadBytes` | 当前固定为 `false` / `null`，不能把未知上传量当成 `0` |
| `warnings` | 保守估算、upstream 快照等提示 |
| `error` | 仅失败时提供 `{ code: "INSPECTION_FAILED", message }`，不返回原始 Git 错误或远端 URL |

## 在上传前执行

仅注册多个独立的 `pre-push` 钩子不能保证失败后停止：Git 仍可能执行后面的 LFS 上传钩子。先运行 `git lfs install --local`（使用 LFS 时），再安装串行包装层：

```bash
yunbox hook install
# 使用 Workstation 的 macOS 对话框/终端确认，而非直接阻止超限推送：
yunbox hook install --guard ~/.local/libexec/git-confirm-large-push
# 恢复原钩子：
yunbox hook uninstall
```

默认包装层调用当前安装的 YunBox CLI，检查未通过便退出。`--guard` 接受绝对路径可执行文件，以它的退出码决定是否执行原钩子；Workstation 适配器仅检查 GitHub remote。原钩子保留为 `pre-push.yunbox-original`，参数和 stdin 原样传递；重复安装不会重复套娃，卸载恢复原文件。发现用户修改过包装层、自定义 `core.hooksPath`、符号链接或未登记的备份时拒绝覆盖。自定义钩子管理器需自行串行接入。移动/卸载 CLI 或 guard 后需重新安装包装层。

包装层只控制它保存的仓库钩子；其他独立 configured hooks 若也上传素材，仍需由它们自己的管理器串联。安装后再次执行 `git lfs install` 可能提示已有钩子；需要更新 LFS 钩子时先卸载包装层，更新后再安装。`git push --no-verify` 会绕过 pre-push 检查。

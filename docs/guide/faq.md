# 常见问题

## 素材存到哪里

::: details 推送时，GitHub LFS 和 COS 会各上传一份吗？
接好 YunBox 直连后不会。`git push` 把代码、提交记录和 LFS 指针发到 Git 远端；git-lfs 把素材内容交给 YunBox，直接上传到配置的 COS 或 S3 兼容存储。同一存储位置已有且大小一致的对象会跳过上传。

```text
git push
├─ 代码、提交记录、LFS 指针 → GitHub / GitLab 等 Git 远端
└─ LFS 素材内容 → YunBox 传输代理 → COS / S3
```

以前已经上传到旧 LFS 服务的素材不会自动删除；迁移时两边可能暂时都有副本。参见[迁移指南](./migrate)。
:::

::: details 为什么协作者仍在访问 GitHub LFS？
传输代理的登记在每份 clone 的本地 Git 配置里，不会随提交传播。仅有 `.yunbox/config` 还不够，协作者也需要安装 CLI、保存自己的密钥并接入：

```bash
npm install -g yunbox
yunbox login
git yunbox clone <仓库地址>
```

已有 clone 时，在仓库目录里运行 `git yunbox init`，再运行 `git lfs pull`。S3 兼容存储使用 `yunbox login --provider s3`。参见[协作者加入](./collaborators)。
:::

::: details status 显示什么？“已登记”意味着可以上传了吗？
`yunbox status` 显示代码目标、素材目标、直连代理是否登记，以及本地 LFS 文件数量和大小。COS / S3 直连不要求配置 `lfs.url`；缺少代理时会提示为当前 clone 运行 `git yunbox init`。

它只读取本地配置和文件，不检查密钥、网络或云端用量。“已登记”不代表远端权限已经通过检查；完整自检用 `yunbox doctor`，只读协作者用 `yunbox doctor --read-only`。
:::

## 没有图形客户端

::: details Windows / Linux 怎么使用？
使用 Node.js、Git、git-lfs 和 `yunbox` CLI 即可，无需 macOS 应用。接入后照常 `git add`、`git commit`、`git push` 和 `git pull`，传输进度由 git-lfs 显示。Windows 使用 Git for Windows 自带的 git-lfs。

推送前可运行 `yunbox inspect --push`；希望每次推送自动检查并在超限时确认，在仓库里运行：

```bash
yunbox hook install --confirm
git config yunbox.confirmUI terminal
```

Windows 从附带的控制台读取确认（例如 PowerShell / Windows Terminal），Linux 从控制终端读取。按回车默认取消；`y` 继续，`n` 取消，也可以写 `n 先压缩图片`。Git Bash 需要进程附带可用的 Windows 控制台；没有控制台的 GUI 或终端环境会取消推送，请在 PowerShell / Windows Terminal 中重试。
:::

::: details macOS 可以在图形确认和纯终端之间切换吗？
可以。默认 `auto` 在本机 macOS 显示原生确认窗口，窗口中可以打开已安装的 YunBox 客户端查看完整信息；无需安装客户端也能确认。SSH 使用终端。

```bash
# 当前仓库始终使用纯终端，包括 pre-push 检查
git config yunbox.confirmUI terminal

# 恢复自动选择；显式使用图形确认可设为 dialog
git config yunbox.confirmUI auto

# 只影响这次手动检查
yunbox inspect --push --confirm --confirm-ui terminal
```

希望所有仓库采用同一偏好，在 `git config` 后加 `--global`。优先级为 `--confirm-ui` > 环境变量 `YUNBOX_CONFIRM_UI` > Git 配置 `yunbox.confirmUI` > `auto`。`none` 不询问，超限时直接取消；这些选择都不会绕过禁推时段。
:::

::: details 为什么 CI 或 GUI 中超限后没有出现确认？
终端确认需要真实的控制终端。Git pre-push 的标准输入是引用更新，不能拿它当作用户回答。没有图形窗口或控制终端时，YunBox 会取消推送并给出提示，不会默认为同意。先处理报告中的超限文件，再从交互终端重试。供脚本读取时使用 `yunbox inspect --push --json`，根据退出码处理结果。
:::

## 读懂终端报告

::: details 如何区分候选量、上传量和已存在对象？
“Git 上传”是压缩后的 pack 估算；“LFS 候选”是本次历史涉及的素材总量。查询存储成功后，报告给出“LFS 上传”和“已存在”，已有对象本次跳过。如果没能查询远端，上传量会标成“未知”，不会当成零。文件列表中的上传大小是原始大小，Git 的压缩和增量传输可能使实际流量更小。

完整口径和 JSON 字段见[推送体积检查](../inspect)。
:::

::: details 颜色分别是什么意思？可以关闭吗？
绿色表示通过，黄色表示提醒或待确认，红色表示失败或超限，青色标识目标和上传信息。没有颜色时也保留状态文字和符号。

交互终端自动使用颜色；管道、重定向、CI、`TERM=dumb` 和 JSON 输出保持纯文本。关闭颜色：

```bash
# macOS / Linux / Git Bash，仅这一次
NO_COLOR=1 yunbox inspect --push
```

```powershell
# PowerShell，当前会话
$env:NO_COLOR = '1'
yunbox inspect --push
Remove-Item Env:NO_COLOR
```
:::

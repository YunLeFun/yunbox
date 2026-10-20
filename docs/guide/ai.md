# 用 AI 编程助手接入

云匣的命令都可以不经交互运行，并输出 JSON，所以可以交给 Claude Code、Codex、Cursor 等编程助手按步骤完成接入。只有一件事留给你自己：**保存腾讯云密钥**。不要把 SecretId / SecretKey 发给 AI，也不要让它写进命令行参数或文件。

## 在客户端里一键复制

[macOS 客户端](./macos) 的「COS 直连」面板（点仓库标题右侧的 COS 状态）有「复制给 AI 的接入说明」。它会生成一段提示词，带上：

- 仓库路径和当前检查结果（已接入、需要处理的项目或未接入）；
- 客户端自带 CLI 的路径，终端里没有安装 `yunbox` 也能用；
- 下面的步骤和安全规则。

粘贴给编程助手即可。

## 自己写提示词

不用客户端时，可以把下面这段发给编程助手，把仓库路径换成你的：

```text
请帮我把这个 Git 仓库接入云匣 YunBox（Git LFS 素材直传我自己的腾讯云 COS），并安装推送检查。
仓库：/path/to/repo

按顺序做，每一步先读 JSON 结果再决定下一步：
1. 运行 `yunbox doctor --json` 查看现状；不清楚的选项看 `git yunbox init --help`。
2. 如果缺少 COS 密钥：停下来，请我自己运行 `yunbox login`。不要向我索要密钥，也不要把密钥写进命令行、文件或仓库。
3. 运行 `yunbox buckets --json`，和我确认 bucket 和目录前缀；新建 bucket 前先问我。
4. 运行 `git yunbox init --bucket <名称-APPID> --region <地域> --prefix <前缀> --yes`。
5. 再运行 `yunbox doctor --json`，确认没有失败项。
6. 运行 `yunbox hook install`。
7. 问我是否需要禁推时段，需要时用 `yunbox freeze set "Mo-Fr 09:00-18:00"`，再用 `yunbox freeze check --json` 核对。
8. 把 .gitattributes 和 .yunbox/config 的改动给我看，由我决定是否提交；不要 git push。
```

终端里没有 `yunbox` 命令时先运行 `npm install -g yunbox`（需要 Node.js 22.18+）。

## 可以交给 AI 的命令

| 命令 | 输出 | 用途 |
| --- | --- | --- |
| `yunbox doctor --json` | 每项检查和修复命令 | 判断现状、核对结果 |
| `yunbox buckets --json` | 本机密钥能看到的 bucket | 选择 bucket |
| `git yunbox init --bucket … --region … --prefix … --yes` | 文本 | 接入，不再提问 |
| `yunbox hook install` | 文本 | 安装 pre-push 检查 |
| `yunbox inspect --push --json` | [体积报告](../inspect#json-接口) | 推送前检查 |
| `yunbox freeze set / list --json / check --json / off / on` | [禁推时段](./freeze) | 设置、查看和临时关闭禁推时段 |

`yunbox login` 也支持 `--secret-key-stdin`，但请自己运行，不要让 AI 转交密钥。

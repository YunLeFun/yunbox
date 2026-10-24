# 云匣 YunBox

**简体中文** · [English](./README.en.md)

![云匣 YunBox：代码交给 Git，素材交给云匣。自己的存储，熟悉的 Git 工作流。](./assets/readme/hero-zh.webp)

[![npm](https://img.shields.io/npm/v/yunbox?color=2563eb)](https://www.npmjs.com/package/yunbox)
[![macOS 下载](https://img.shields.io/github/v/release/YunLeFun/yunbox?label=macOS&color=2563eb)](https://github.com/YunLeFun/yunbox/releases/latest)
[![MIT License](https://img.shields.io/badge/license-MIT-2563eb)](./LICENSE)

**让游戏、设计和音视频项目继续用熟悉的 Git 工作流。** 云匣兼容 Git LFS，代码留在 GitHub 等代码平台，素材直传你自己的腾讯云 COS、Cloudflare R2、AWS S3 或 MinIO。推送前检查 Git 和 LFS 体积，在大文件上传前让你确认。

[官网与演示](https://yunbox.yunle.fun/) · [快速开始](./docs/guide/index.md) · [下载客户端](https://github.com/YunLeFun/yunbox/releases/latest) · [更新日志](./docs/changelog.md)

## 云匣能做什么

| 你想做的事 | 云匣提供的能力 |
| --- | --- |
| 把素材存在自己的云上 | COS 和 S3 兼容存储直连，保留 `git add`、`commit`、`push`、`clone` 工作流，无需部署服务端 |
| 推送前看清会上传什么 | 分开统计 Git pack 和 LFS 素材，列出超限文件，支持确认后继续、说明取消原因和禁推时段 |
| 用图形界面管理素材 | macOS 原生客户端：预算、文件变化、图片对比、文本差异、存储接入和菜单栏状态 |
| 让素材正确走 LFS | 按贴图、设计稿、模型、音频等类型管理规则，支持游戏、设计、媒体预设 |
| 和团队协作 | 共享不含密钥的仓库配置；每人独立凭据；`doctor` 自检与修复提示 |
| 在脚本和 AI 工作流里使用 | macOS、Linux、Windows CLI，结构化 JSON 报告和可读的推送确认原因 |

### 真实界面

<p>
  <img src="./docs/guide/images/macos-asset-types-light.jpg" alt="macOS 素材类型面板：预设组合、LFS 规则和文件统计" width="49%">
  <img src="./docs/guide/images/macos-asset-types-dark.jpg" alt="macOS 素材类型面板深色模式：发现普通 Git 文件并转为 LFS" width="49%">
</p>

*真实客户端的素材类型面板（中文界面）。客户端同时支持英文；顶部主图是宣传插画。更多功能见 [macOS 客户端指南](./docs/guide/macos.md)。*

## 快速开始

### 安装命令行

需要 **Node.js 22.18+（22.x）或 24.11+（24.x）或 26+**、**Git 2.30+** 和 **Git LFS 3.2+**。推荐 Node.js 24 LTS；Windows 使用 Git for Windows。

```bash
npm install -g yunbox
```

同时安装 `yunbox` 和 `git-yunbox`，`git yunbox <命令>` 与 `yunbox <命令>` 等价。查看帮助用 `yunbox --help` 或 `git yunbox help`（Git 会把 `git yunbox --help` 当作查找 man 手册）。

想用图形界面，可以[下载 macOS 客户端](https://github.com/YunLeFun/yunbox/releases/latest)，解压后拖入「应用程序」。App 内置 CLI，仍需要本机的 Node.js、Git 和 Git LFS；在终端直接使用命令时按上面的方式安装。

> **版本说明：** 从 0.1.6 起客户端要求 macOS 26+，经过 Apple 公证并支持自动更新；macOS 14 / 15 可使用 [0.1.5](https://github.com/YunLeFun/yunbox/releases/tag/v0.1.5)。命令行的系统支持范围不变，版本变化见[更新日志](./docs/changelog.md)。

### 先体验推送检查

在已有 Git 仓库中运行，无需接入云存储：

```bash
yunbox inspect --push           # 查看准备推送的 Git / LFS 体积
yunbox hook install --confirm   # 为本仓库安装保护，超限时询问
```

检查通过后再执行仓库原有的 pre-push 钩子和 LFS 上传。macOS 可以弹出确认框，关闭云匣 App 后仍可检查和确认；没有人确认时取消推送。默认预算是 Git pack **900 KiB**、LFS **100 MiB**、单文件 **10 MiB**，都可调整，这些是推送提醒阈值。

```bash
yunbox inspect --push --json       # 给脚本或工具读取
yunbox freeze set "Mo-Fr 09:00-18:00" # 可选：工作时间禁止推送
```

禁推时段会直接阻止推送。完整参数、预算配置和确认方式见[推送检查](./docs/inspect.md)与[禁推时段](./docs/guide/freeze.md)。

### 接入自己的素材存储

直连模式中，素材由本机传输代理签名，直接在电脑与对象存储之间传输：

```text
代码和 LFS 指针 ── git push / clone ──▶ GitHub 等 Git 平台
素材内容       ── git-lfs ──▶ YunBox 传输代理 ──▶ 你自己的 COS / S3 存储
```

**腾讯云 COS：** 管理员先安装并登录 [腾讯云 CLI](https://github.com/TencentCloud/tencentcloud-cli)，再在已有 Git 仓库里接入：

```bash
tccli auth login
git yunbox init                 # 选择或新建私有 bucket，检查读写权限
yunbox subaccount create --save  # 为自己创建权限受限的长期密钥并保存到本机
git add .gitattributes .yunbox/config
git commit -m "chore: store LFS assets with YunBox"
git push
```

**Cloudflare R2、AWS S3 或 MinIO：** 先创建私有 bucket 和对应的访问密钥，再运行：

```bash
yunbox login --provider s3
git yunbox init --preset r2      # 也可用 aws、minio；按提示填写存储信息
```

接入后提交 `.gitattributes` 和 `.yunbox/config`。完整步骤见 [COS 快速开始](./docs/guide/index.md)与 [R2 / S3 指南](./docs/guide/r2.md)。已有 GitHub LFS 素材时，先按[迁移指南](./docs/guide/migrate.md)搬运历史对象。

**协作者加入：** 从管理员处取得自己的存储凭据，然后登录并 clone：

```bash
yunbox login                     # S3 兼容存储加 --provider s3
git yunbox clone <仓库地址>
yunbox doctor
```

详见[协作者指南](./docs/guide/collaborators.md)。每个 clone 都要登记本机传输代理；普通 `git clone` 后也可运行 `git yunbox init`，再执行 `git lfs pull`。

### 新手引导与默认保护

从 0.1.6 起：

- App 首次打开依次检查环境、选择仓库、设置推送保护，再可选接入存储；可从帮助或设置重新打开。
- `git yunbox init` 引导安装当前仓库的推送钩子，默认超限询问；已有保护设置会保留，`--no-hook` 可跳过。
- 全局保护由用户主动选择：向导勾选「应用到本机所有仓库」，或运行 `yunbox hook install --global`。卸载用 `yunbox hook uninstall --global`，检查实际状态用 `yunbox hook status`。
- 全局安装保留仓库原有钩子，遇到其他全局钩子管理器会停止；仓库自己的 `core.hooksPath` 可能覆盖全局配置，向导会显示实际是否生效。

## 常用命令

| 命令 | 用途 |
| --- | --- |
| `yunbox doctor` | 检查配置、凭据、代理和存储权限，给出修复建议 |
| `yunbox status --all` | 查看所有分支和历史引用的 LFS 用量，不访问网络 |
| `git yunbox types` | 查看素材类型、LFS 规则和未走 LFS 的文件 |
| `git yunbox types add model,audio` | 追加指定素材类型的 LFS 规则 |
| `git yunbox types add archive --renormalize` | 从下一次提交起把匹配的文件改为 LFS，改动会加入暂存区；历史不变 |
| `git yunbox types remove video` | 移除云匣生成的视频规则，保留手写规则 |
| `yunbox freeze off --for 1h` | 暂停禁推时段一小时，到点恢复 |

## 存储与协作边界

- **配置可共享，密钥留本机。** `.yunbox/config` 只包含存储位置。macOS 优先使用登录钥匙串；不可用时以及 Linux、Windows 使用本机凭据文件。请为协作者分别分配最小权限密钥。
- **素材按内容寻址。** 相同内容复用对象，下载时校验大小和 SHA-256。
- **直连模式没有文件锁。** 同一份二进制素材请协调编辑，避免多人同时修改。
- **也可部署服务端。** 需要集中签发和吊销个人 token 时，使用[服务端模式](./docs/deploy.md)；对象存储模式下，素材仍直传 COS。

## 文档

| 从这里继续 | 内容 |
| --- | --- |
| [快速开始](./docs/guide/index.md) / [协作者加入](./docs/guide/collaborators.md) | COS 接入、子账号与团队协作 |
| [R2 和 S3](./docs/guide/r2.md) / [迁移已有 LFS](./docs/guide/migrate.md) | 存储选项与历史素材迁移 |
| [推送检查](./docs/inspect.md) / [禁推时段](./docs/guide/freeze.md) | 预算、确认与时段规则 |
| [macOS 客户端](./docs/guide/macos.md) / [AI 辅助接入](./docs/guide/ai.md) | 图形界面与 AI 工作流 |
| [常见问题](./docs/guide/faq.md) / [更新日志](./docs/changelog.md) | 使用疑问与版本变化 |
| [宣传素材](./assets/readme/README.md) | 中英文主图、用途与生成提示词 |

## 开发

使用 `.node-version` 指定的 Node.js 24 和 `package.json` 指定的 pnpm 版本：

```bash
pnpm install
pnpm build
pnpm lint
pnpm typecheck
pnpm test

pnpm docs:dev
pnpm docs:build
```

| 目录 | 内容 |
| --- | --- |
| `packages/core` | LFS 协议类型、输入校验和存储接口 |
| `packages/cli` | `yunbox` / `git-yunbox` 命令与内置存储提供方 |
| `packages/server` | Batch、Verify、对象传输和元数据服务 |
| `apps/macos` | SwiftUI 客户端，复用 CLI 的检查逻辑 |
| `docs` | 中英双语 VitePress 官网和文档 |

CLI 测试在 `packages/cli/test/`，真实 Git / git-lfs 的服务端端到端测试在 `packages/server/test/`。默认测试使用独立临时目录和本地测试替身，不需要云端凭据；真实云资源测试单独启用，见[部署指南](./docs/deploy.md)。直连存储提供方均为内置实现，扩展约定见[存储开发说明](./packages/cli/src/storage/README.md)。

macOS 源码构建需要 Xcode 27.1（macOS 27.0 SDK），运行 `./script/build_and_run.sh --install` 安装到 `~/Applications/YunBox.app`。打包、签名和自动更新配置见[客户端 README](./apps/macos/README.md)。

<details>
<summary>本地服务、管理命令与发布</summary>

### 启动本地服务

在仓库根目录创建 token 并启动服务，创建时仅显示一次明文 token：

```bash
pnpm --filter @yunbox/server start token create --name alice --write demo/assets --storage-dir .yunbox-data
pnpm --filter @yunbox/server start --port 8080 --storage-dir .yunbox-data
```

在另一个终端的测试 Git 仓库中接入，按提示输入 token，使用 Git 凭据管理器保存：

```bash
git yunbox init --url http://127.0.0.1:8080/demo/assets
git add .gitattributes .lfsconfig
git commit -m "chore: configure YunBox LFS"
yunbox doctor
```

服务默认只监听 `127.0.0.1:8080`，`GET /_health` 可用于探活。这是本地开发配置；监听其他地址必须提供 HTTPS 的 `--public-url`，生产部署还需按[部署指南](./docs/deploy.md)配置存储、元数据和访问控制。

### 管理 token 和授权

管理命令必须使用与服务端相同的存储和元数据配置。下面沿用本地示例的 `.yunbox-data`：

```bash
pnpm --filter @yunbox/server start token list --storage-dir .yunbox-data
pnpm --filter @yunbox/server start token revoke alice --storage-dir .yunbox-data
pnpm --filter @yunbox/server start grant list --storage-dir .yunbox-data
pnpm --filter @yunbox/server start grant set alice --write 'team/assets' --read 'team/*' --storage-dir .yunbox-data
```

token 默认 90 天有效，`token create --expires-in 30d` 可调整；`grant set` 整体替换用户授权。服务端缓存和已签发的 COS 地址使吊销最迟 5 分钟后完全生效。旧 `tokens.json` 的迁移用 `token migrate`，详见[部署指南](./docs/deploy.md)。

### 用 `cos setup` 交互配置

服务端模式可按仓库路由选择不同 bucket 或前缀：

```bash
pnpm --filter @yunbox/server start cos setup
pnpm --filter @yunbox/server start cos routes
pnpm --filter @yunbox/server start cos check
pnpm --filter @yunbox/server start --storage cos --storage-config yunbox.storage.json
```

配置文件只记录路由、不含密钥；运行时的 COS 凭据和 CloudBase 元数据配置见[部署指南](./docs/deploy.md)。

### 发布（维护者）

发布说明来自 [`docs/changelog.md`](./docs/changelog.md) 和 [`docs/en/changelog.md`](./docs/en/changelog.md)，官网、GitHub Release 和客户端更新提示共用这两份内容。

1. 把用户能感知的变化写入两种语言的「未发布 / Unreleased」，按新增、变更、修复分组，确认兼容性变化和升级步骤已说明。
2. 预览并检查，确认条目完整后提交本轮改动，保持工作区干净：

   ```bash
   pnpm release:notes
   pnpm build && pnpm lint && pnpm typecheck && pnpm test
   git status --short
   ```

3. 运行 `pnpm release`，选择版本号。它会把待发布条目归入该版本，同时修改 CLI 版本、提交、打 tag 并推送。
4. 查看 Release 工作流：摘要展示本次双语说明；检查通过后发布 npm，再构建、签名、公证 macOS 更新包；Release 先建为草稿，两个附件上传后才公开。流程重跑时也会刷新已有 Release 的说明。
5. 发布后核对 GitHub 正文、npm 版本，以及 `YunBox-macOS.zip`、`appcast.xml` 两个附件。可用 `pnpm release:notes 0.1.5` 预览某个历史版本的预期正文，或 `gh release view v0.1.5 --repo YunLeFun/yunbox` 查看线上结果（版本号按实际替换）。

历史版本只缺正文时，先预览对应版本，然后单独补录，不必重跑 npm 发布或重新打 tag：

```bash
(
  notes_dir=$(mktemp -d)
  trap 'rm -rf "$notes_dir"' EXIT
  node script/changelog.mjs github 0.1.4 > "$notes_dir/notes.md" &&
    gh release edit v0.1.4 --repo YunLeFun/yunbox --notes-file "$notes_dir/notes.md"
)
```

旧版的 `--generate-notes` 主要按已合并 PR 汇总，直接提交较多时可能只剩版本对比链接（[GitHub 说明](https://docs.github.com/en/repositories/releasing-projects-on-github/automatically-generated-release-notes)）。[changelogithub](https://github.com/antfu-collective/changelogithub) 可以从 Conventional Commits 生成草稿，适合辅助查漏；正式发布采用审校后的双语日志。官网部署与客户端签名配置见[工作流](./.github/workflows/)和[客户端 README](./apps/macos/README.md)。

</details>

## License

[MIT](./LICENSE) · [云乐坊 YunLeFun](https://github.com/YunLeFun)

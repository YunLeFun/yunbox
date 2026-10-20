# 云匣 YunBox

> 兼容 Git LFS 的素材托管。代码交给 Git，素材交给云匣。

**状态：默认改为直连 COS，不需要任何服务端。已在真实腾讯云 COS 上跑通推送、clone、恢复旧版本和重复推送；命令行和传输代理在 macOS、Linux、Windows（Git for Windows）上都由 CI 实测通过；npm 发布已准备好，等配置发布凭据。**

代码仍托管在 GitHub 等平台，LFS 大文件存到你自己的腾讯云 COS。每个协作者在自己电脑上用 `yunbox login` 保存自己的子账号密钥，git-lfs 通过 YunBox 的传输代理直接上传、下载 COS，**中间没有服务端**。需要集中签发 token 时，也可以改用[服务端模式](#服务端模式)。

也可以直连 Cloudflare R2、AWS S3、MinIO 等 S3 兼容存储（`git yunbox init --preset r2`，`yunbox login --provider s3`），见 [接入 R2 和 S3 兼容存储](./docs/guide/r2.md)。

- 官网和使用文档：[yunbox.yunle.fun](https://yunbox.yunle.fun/)（下载、功能演示和指南；[文档源码](./docs/)）
- 方案与里程碑：[docs/plan.md](./docs/plan.md)
- 部署到 CloudBase 云托管：[docs/deploy.md](./docs/deploy.md)

## 直连 COS（推荐）

```
git push / clone ──▶ git-lfs ──▶ git-yunbox lfs-agent ──▶ 腾讯云 COS
                                   用本机密钥签名，直接上传 / 下载，不经过任何服务端
```

先按[安装命令行](#安装命令行)装好 `yunbox`。

**管理员第一次接入仓库：**

```bash
tccli auth login             # 浏览器登录腾讯云（管理员身份，临时密钥约 2 小时）
git yunbox init              # 列出 bucket → 选一个或新建私有 bucket → 填目录前缀 → 读写探测
git add .gitattributes .yunbox/config
git commit -m "chore: 用 YunBox 把 LFS 素材直传到 COS"
git push

yunbox subaccount create --save   # 给自己建只能读写这个前缀的子账号，长期密钥存进本机钥匙串
```

最后一步之后，这台电脑就一直用这把长期子账号密钥，不用再每两小时 `tccli auth login`；`yunbox doctor` 在还用着 tccli 临时密钥时会提醒。

**给协作者开子账号**（同样用管理员的 `tccli auth login`）：

```bash
yunbox subaccount create yunbox-alice --show-key              # 新建并显示一次密钥，通过安全渠道转交
yunbox subaccount create yunbox-bob --show-key --read-only    # 只需要拉取的人
yunbox subaccount grant yunbox-alice                          # 在另一个已接入的仓库里运行：给她再授权这个仓库
yunbox subaccount list                                        # YunBox 建的子账号和各自能访问的前缀
yunbox subaccount delete yunbox-alice                         # 人员离开：删除子账号、密钥和策略，立即失效
```

- 子账号只能编程访问（不能登录控制台），策略只授权这个前缀下对象的 `PutObject`、`GetObject`、`HeadObject`（只读去掉 `PutObject`），不能列出 bucket、不能删除、碰不到其他前缀。策略内容就是 `yunbox policy` 的输出，想在控制台手动建也可以，步骤见 [docs/deploy.md](./docs/deploy.md#直连模式给协作者开子账号)。
- `--save` 会等权限生效后用新密钥实测读写；权限改动要几十秒到一两分钟才在 COS 各节点全部生效。
- `subaccount` 只用管理员身份（`tccli auth login` 或 `TENCENTCLOUD_*` 环境变量）调用 CAM，不会用、也不会改动本机已保存的子账号密钥；`delete` 只删 YunBox 建的子账号。

**协作者：**

```bash
yunbox login                 # 用管理员分配给你的子账号密钥
git yunbox clone <仓库地址>   # = clone 历史 + git yunbox init + git lfs pull
```

- **共享的只有位置**：`.yunbox/config` 记录 bucket、地域和目录前缀，提交到仓库供团队共享，**不含任何密钥**。`.yunbox/` 目录只放提交、共享的文件，密钥和传输代理的登记不会写进去。0.1.x 版本用的是仓库根目录的 `.yunboxconfig`，新版本仍然读取它，`yunbox doctor` 会给出迁移命令。不同项目可以用不同 bucket，也可以共用一个 bucket、各用一个前缀（默认 `yunbox/<owner>/<repo>`）。对象键是 `<前缀>/<oid[0:2]>/<oid[2:4]>/<oid>`。
- **密钥只在各自电脑上**：macOS 上 `yunbox login` 存进登录钥匙串的「yunbox」项（用系统自带的 `security` 命令，SecretKey 经标准输入传入，不出现在命令行参数和进程列表里）；钥匙串不可用时、以及 Linux 和 Windows 上，存在 `~/.config/yunbox/credentials.json`（Windows 为 `%APPDATA%\yunbox`，权限 600）。`YUNBOX_CREDENTIAL_STORE=file` 可以强制用文件。读取顺序是 `TENCENTCLOUD_SECRETID` / `TENCENTCLOUD_SECRETKEY` 环境变量 > 钥匙串 > 文件 > `tccli auth login` 的临时密钥（约 2 小时有效）。`yunbox logout` 同时清理钥匙串和文件。SecretKey 不接受命令行参数。
  - 钥匙串项信任创建它的 `/usr/bin/security`，所以读取时不弹窗；这也意味着同一用户下的其他程序同样能读到它。它防的是明文文件被备份、同步或误传，不防本机的恶意程序。
  - Windows 凭据管理器暂不支持：不加依赖的办法只有 `cmdkey`（密码要放在命令行参数里，且不能读回）或 PowerShell 现场编译调用 `CredWrite` / `CredRead`（每次启动要编译 C#，受限语言模式下不可用），都还没在 Windows 上验证，先继续用文件；`%APPDATA%` 默认只有本人和管理员能访问。
- **给别人用的安全边界**：每人一个 CAM 子账号，只授权团队 bucket 里对应前缀的 `PutObject`、`GetObject`、`HeadObject`（只需拉取的人去掉 `PutObject`），用 `yunbox policy` 生成；人员变动时在 CAM 里禁用或删除他的密钥即可。
- **数据可靠性**：上传带 `x-cos-forbid-overwrite`，已存在的对象不会被覆盖；对象按内容寻址，同样的文件只传一次。下载时校验大小和 SHA-256，内容被替换或损坏的对象不会交给 git-lfs。
- **为什么每个人都要装 YunBox 命令行**：git-lfs 出于安全考虑，不允许仓库通过 `.lfsconfig` 指定传输程序，所以传输代理只能由 `git yunbox init` 写进各自 clone 的 `.git/config`。`yunbox doctor` 会检查代理是否登记、密钥是否可用、能否读写前缀。
- **限制**：没有服务端就没有文件锁（Locks API），`lfs.locksverify` 设为 `false`，同一素材同一时间请只由一人编辑。

## 当前能力

- **直连 COS**：git-lfs 独立传输代理 `git-yunbox lfs-agent`、`yunbox login` / `logout`（macOS 存钥匙串，其他系统存 600 文件）、`yunbox policy`（输出子账号最小权限策略）、`git yunbox init`（交互选择或新建 bucket）、`git yunbox clone`、`yunbox doctor` 的直连检查、`yunbox buckets`；`doctor` 和 `buckets` 都支持 `--json`，供图形界面读取
- Git LFS Batch API：upload / download，`transfer: basic`
- Verify API：核对对象大小并持久化“已校验”状态
- 仓库隔离的本地文件存储，以及由服务端提供的签名 PUT / GET 地址
- 腾讯云 COS 存储：服务端只签发预签名地址，素材由 git-lfs 直接上传到 COS、从 COS 下载，不经过服务端
- 个人 token 鉴权（HTTP Basic，用户名任意，密码是 token），按用户授权仓库读写，token 默认 90 天过期，可单独吊销
- 元数据存储（token、仓库授权、文件锁、审计日志）：本地文件版本用于开发和测试，生产使用 CloudBase 文档数据库；对象和已校验标记仍在 COS
- 请求超时、并发上限、请求体大小限制、统一的 LFS JSON 错误格式、脱敏的访问日志
- 真实 `git` 和 `git-lfs` 端到端测试（通过 Git 凭据管理器提供 token）
- Docker 镜像、免鉴权的健康检查 `GET /_health`、全部来自环境变量的配置和启动时的配置自检
- 命令行 `git yunbox init` / `yunbox doctor` / `yunbox status`：一条命令接入仓库，自检配置、凭据和读写权限；`git yunbox types` 按素材类型查看、添加、移除 LFS 规则
- [推送体积检查](./docs/inspect.md)：`yunbox inspect --push` 分别统计 Git pack 和 LFS 候选量，列出超限文件，支持 JSON；`yunbox hook install` 在原有上传钩子前串行执行检查；`yunbox freeze set "Mo-Fr 09:00-18:00"` 按 opening_hours 写法设置[禁推时段](./docs/guide/freeze.md)（如工作时间），时段内直接中断推送
- [macOS 原生客户端](./apps/macos/README.md)：选择仓库查看 Git/LFS 预算、搜索超限文件、复制完整 JSON；显示 COS 直连状态，可以在窗口里保存密钥、选择或新建 bucket 一键接入；SwiftUI 界面复用 CLI，可安装到本机 Applications

默认只监听 `127.0.0.1`。监听其他地址时必须用 `--public-url` 配置 https 地址，否则拒绝启动；Basic 认证的内容是明文，**公网部署必须经过 HTTPS**。部署方式见 [docs/deploy.md](./docs/deploy.md)，按其中的检查清单确认之前不要把服务暴露到其他网络。

## 开发

需要 Node.js 22.18+（推荐读取 `.node-version` 使用 Node.js 24）、pnpm 和原版 `git-lfs`。

```bash
pnpm install
pnpm build
pnpm lint
pnpm typecheck
pnpm test
```

工作区目前包含三个包：

- `packages/core`：LFS 协议类型、输入校验、存储接口、本地文件存储和 COS 存储
- `packages/server`：基于 `node:http` 的 Batch、Verify、PUT 和 GET 服务，以及元数据存储（`metadata.ts` 定义接口，`metadata-local.ts` 和 `metadata-cloudbase.ts` 是两个实现）
- `packages/cli`（包名 `yunbox`）：协作者使用的 `yunbox` / `git-yunbox` 命令。直连模式的存储（COS、S3 兼容存储）是内置的提供方，不支持第三方插件；接口和新增步骤见 [`packages/cli/src/storage/README.md`](./packages/cli/src/storage/README.md)

以及官网 `docs/`（`@yunbox/docs`，VitePress）：首页的演示组件在 `docs/.vitepress/theme/components/`，`deploy.md`、`inspect.md` 直接作为站点页面，`plan.md`、`goal*.md` 是内部规划，不进站点。文档里指向仓库其他位置的相对链接，构建时改写成 GitHub 地址，所以同一份 Markdown 在 GitHub 和官网上都能点。

```bash
pnpm docs:dev      # 本地预览官网
pnpm docs:build    # 输出到 docs/.vitepress/dist
```

官网通过 Cloudflare Pages 项目 `yunbox` 连接本仓库，`main` 更新后自动部署到 [yunbox.yunle.fun](https://yunbox.yunle.fun/)。构建从仓库根目录执行 `pnpm install --frozen-lockfile && pnpm docs:build`，输出目录为 `docs/.vitepress/dist`；环境变量设为 `PNPM_VERSION=11.28.5`、`SKIP_DEPENDENCY_INSTALL=1`、`SITE_BASE=/`，Node.js 版本读取 `.node-version`。

自定义域名在 Pages 项目中绑定；DNS 使用 `yunbox` → `yunbox.pages.dev` 的 CNAME，代理状态为「仅 DNS」，由 Pages 提供 HTTPS 和 CDN。2026-10-20 排查时，开启代理后的地址在当前网络中断开 HTTPS 连接，直接连接 Pages 则正常。遇到同类问题，先对比自定义域名与 [Pages 默认地址](https://yunbox.pages.dev/)，再检查 DNS；修改后旧解析可能缓存到 TTL 到期。

`Docs` 工作流在 main 上的 `docs/` 有改动、以及每次 `Release` 结束后构建并发布到 [GitHub Pages 默认地址](https://yunlefun.github.io/yunbox/)（需要在仓库设置里把 Pages 的来源设为 GitHub Actions）。两处部署各自使用对应的网站路径，GitHub Pages 不绑定自定义域名。下载区在构建时查询最新 release 是否带 macOS 安装包，没有时改为提示从源码构建；`Release` 工作流在 npm 发布成功后创建 GitHub release，并附上通用二进制的 `YunBox-macOS.zip`（ad-hoc 签名，未公证）。

命令行的测试位于 `packages/cli/test/`：用真实的 `git` 和 `git-lfs` 在临时目录里检查 `init` 生成的配置和幂等性，并对本仓库的服务端（本地存储加 token）检查 `doctor` 在通过、缺少凭据、只读 token、无效 token 等情况下的输出和退出码。测试使用独立的 HOME 和 `credential.helper store`，不会碰到本机的钥匙串。 `s3-direct.test.ts` 用 S3 测试替身（`packages/core/test/fake-s3-server.ts`，用 AWS SDK 的签名器重新核对每个 SigV4 签名和请求体哈希）跑完整的直连 S3 流程；`s3-live.test.ts` 对真实的 R2 / S3 / MinIO 运行，默认跳过（`YUNBOX_S3_E2E=1`，变量见文件开头）。

端到端测试位于 `packages/server/test/`：`e2e.test.ts` 分别用「本地存储 + 本地元数据」和「COS 测试替身（`packages/core/test/fake-cos-server.ts`，用官方 SDK 重新核对每个签名）+ CloudBase 文档数据库测试替身（`fake-cloudbase-server.ts`，用官方签名库 `@cloudbase/signature-nodejs` 重新核对换取 token 的签名，数据请求只认它签发的 token）」跑同一套 git-lfs 流程（`lfs-workflow.ts`），不需要任何云端凭据。流程通过 `credential.helper store` 把 token 交给 git-lfs，并覆盖只读 token 不能 push、无权限的仓库被拒、过期 token、未提供凭据和吊销后被拒。`metadata.test.ts` 对本地文件版和 CloudBase 版跑同一套元数据契约测试（`metadata-contract.ts`，包括跨实例的并发签发、吊销、授权修改和抢锁）。`cos-live.test.ts` 和 `metadata-live.test.ts` 分别对真实 COS 和真实 CloudBase 运行，默认跳过。

## 启动本地服务

先创建 token，再启动服务端。命令行入口是 `yunbox-server`（`packages/server/src/cli.ts`）；在仓库里可以用 `pnpm --filter @yunbox/server start` 运行，构建后也可以直接运行 `node packages/server/dist/cli.mjs`。

```bash
pnpm --filter @yunbox/server start token create --name alice --write demo/assets --storage-dir .yunbox-data
pnpm --filter @yunbox/server start --port 8080 --storage-dir .yunbox-data
```

- 服务默认监听 `http://127.0.0.1:8080`，`--port 0` 可让系统分配临时端口。
- 每个参数都有对应的环境变量：`YUNBOX_HOST`、`YUNBOX_PORT`（其次读平台设置的 `PORT`）、`YUNBOX_PUBLIC_URL`、`YUNBOX_STORAGE`、`YUNBOX_STORAGE_DIR`、`YUNBOX_METADATA`、`YUNBOX_METADATA_DIR`，命令行参数优先。启动前会检查全部配置，缺什么一次列出并以状态码 1 退出，错误信息里不会出现任何配置值或密钥。
- `GET /_health` 不需要鉴权，只返回 `{"status":"ok"}`，供容器平台探测；成功的探测不写访问日志。
- `--host 0.0.0.0 --public-url https://lfs.example.com`：监听其他地址时必须同时给出 https 的 `--public-url`，上传、下载和 verify 地址都基于它生成。服务端不读取任何 `X-Forwarded-*` 头，所以反向代理不需要额外的信任设置；TLS 由反向代理终止。
- 每个请求输出一行 JSON 访问日志（请求 id、方法、不含查询串的路径、状态码、耗时、token id），不包含 token、`Authorization` 头和任何上传或下载地址。

### 管理 token 和授权

`token` 和 `grant` 子命令只在部署环境或管理员本机执行，存储参数（`--storage`、`--storage-dir`、`--metadata`、`--metadata-dir`，或对应的环境变量）要和服务端一致：

```bash
# 创建：只在这里输出一次明文 token；服务端只保存它的 SHA-256 哈希
pnpm --filter @yunbox/server start token create --name alice --write 'team/game-assets' --read 'team/*'
# 同一个人的第二个 token（例如 CI 用），沿用 alice 的授权，30 天过期
pnpm --filter @yunbox/server start token create --name alice-ci --user alice --expires-in 30d
# 列出：显示 id、名称、用户、创建时间、过期时间和最后使用时间，不显示哈希
pnpm --filter @yunbox/server start token list
# 吊销：按 id 或名称
pnpm --filter @yunbox/server start token revoke alice-ci
# 查看和修改授权；grant set 整体替换某个用户的授权，不带 --read / --write 则删除
pnpm --filter @yunbox/server start grant list
pnpm --filter @yunbox/server start grant set alice --write 'team/game-assets' --read 'team/*'
```

- 每个 token 属于一个用户（`--user`，默认和 token 名称相同），权限来自这个用户的授权，所以同一个人的所有 token 权限相同。`token create` 的 `--read` / `--write` 会加到用户的授权里，只增不减；要收回权限用 `grant set`。用户还没有任何授权时，`token create` 必须带 `--read` 或 `--write`。
- 权限写成 `<owner>/<repo>` 或 `<owner>/*`（在 shell 里要加引号）。`write` 包含 `read`；同一个仓库同时匹配精确条目和通配条目时，以精确条目为准，例如 `--write 'team/*' --read team/locked` 对 `team/locked` 只有读权限。
- token 默认 90 天后过期，`--expires-in` 可以改成例如 `30d`、`12h`、`30m`（最长 3650 天）。过期的 token 和无效 token 一样返回 401；服务端签发的上传、下载地址也不会比 token 活得更久。
- 服务端记录每个 token 的最后使用时间，同一个 token 最多每小时写一次，不会每个请求都写数据库。
- 元数据的位置：本地模式在 `<storage-dir>/_yunbox/metadata/`（`--metadata-dir` 可改；每条记录一个文件，目录 `0700`、文件 `0600`）。COS 存储默认使用 CloudBase 文档数据库，配置见 [docs/deploy.md](./docs/deploy.md)。每个 token 是单独的一条记录，几个管理员同时签发和吊销不会互相覆盖。
- 服务端最多缓存 token 和授权 30 秒。上传、下载地址的有效期从授权时所用的缓存的读取时间算起，最长 5 分钟，所以**吊销和收回授权最迟 5 分钟后完全生效**：服务端自己签发的地址每次使用都要重新鉴权，30 秒内失效；COS 预签名地址无法撤回，只能等它过期。
- token 丢失后无法找回，吊销后重新创建即可。

### 从旧版 `tokens.json` 迁移

旧版本把 token 存在 `<storage-dir>/_yunbox/tokens.json` 或 COS 的 `<prefix>/_yunbox/tokens.json`，新版本不再读取它（启动时发现旧文件而新存储里没有 token，会提示执行迁移）。用和服务端相同的配置执行一次：

```bash
pnpm --filter @yunbox/server start token migrate
```

- 已发出的 token 明文、格式和哈希都不变，迁移后继续可用。每个旧 token 变成一个同名用户，旧 token 上的仓库权限成为这个用户的授权。
- 旧 token 没有过期时间，迁移时统一设为迁移后 90 天过期（`--expires-in` 可改），请在此之前给大家换发新 token。
- 可以重复执行：已经迁移过的 token 会跳过，迁移后被吊销的 token 也不会被重新导入。迁移记录写在审计日志里（`token.migrate`）。
- 旧文件不会被删除，确认迁移结果后自行删除或归档。

### 使用 COS 存储

```bash
export YUNBOX_COS_BUCKET=examplebucket-1250000000
export YUNBOX_COS_REGION=ap-guangzhou
export YUNBOX_COS_PREFIX=yunbox            # 可选，所有仓库共用的键前缀
export TENCENTCLOUD_SECRETID=...           # 通过安全渠道注入，不要写进仓库
export TENCENTCLOUD_SECRETKEY=...
export TENCENTCLOUD_SESSIONTOKEN=...       # 使用临时密钥时需要
pnpm --filter @yunbox/server start --storage cos
```

- bucket 必须是私有读写。服务端需要的权限只有 `PutObject`、`GetObject`、`HeadObject`、`DeleteObject`（删除只用于已校验标记）。
- 对象键为 `<prefix>/<owner>/<repo>/<oid[0:2]>/<oid[2:4]>/<oid>`，旁边的 `<oid>.verified.json` 是已校验标记。
- 上传地址的签名包含 `Content-Length`，大小不符的上传会被 COS 直接拒绝。下载地址的签名包含 `If-Match: <ETag>`，对象在校验后被覆盖时 COS 会拒绝下载。

#### 用 `cos setup` 交互配置，按项目选 bucket

不想手写环境变量时，用管理员命令交互选择：

```bash
tccli auth login                      # 或者设置 TENCENTCLOUD_SECRETID / TENCENTCLOUD_SECRETKEY
yunbox-server cos setup               # 列出 bucket → 选一个或新建私有 bucket → 填前缀和适用的仓库 → 读写探测 → 保存
yunbox-server cos routes              # 查看已配置的路由
yunbox-server cos check               # 用当前凭据逐条探测读写权限
yunbox-server --storage cos --storage-config yunbox.storage.json
```

- 配置保存在 `yunbox.storage.json`（可用 `--config` 或 `YUNBOX_STORAGE_CONFIG` 指定），只记录仓库范围、bucket、地域和前缀，**不含任何密钥**。仓库的 `.gitignore` 默认忽略它。
- 每条路由的 `repos` 是 `<owner>/<repo>`、`<owner>/*` 或 `*`，精确匹配优先于通配。不同项目可以用不同 bucket，也可以共用一个 bucket、各用一个前缀；对象键总是 `<prefix>/<owner>/<repo>/...`，不同仓库不会共用键。没有匹配路由的仓库会被拒绝（404）。
- 新建 bucket 前会二次确认，新建的 bucket 一律私有读写。保存前会用当前凭据在 `<prefix>/_yunbox/` 下写入、读取、删除一个探测对象，失败就不保存。
- `setup` 用的是管理员自己的凭据（环境变量或 `tccli auth login` 的临时密钥）。服务端运行时仍然只读 `TENCENTCLOUD_*` 环境变量，上线前在服务端环境里跑一次 `cos check`，确认运行角色也能访问每条路由。
- 容器里可以把配置直接放进环境变量：`YUNBOX_STORAGE_CONFIG='{"version":1,"routes":[...]}'`。
- 设置了 `--storage-config` 时，`YUNBOX_COS_BUCKET` / `REGION` / `PREFIX` 不再使用。

COS 存储默认把元数据放在 CloudBase 文档数据库，还需要 `YUNBOX_CLOUDBASE_ENV` 等变量，见 [docs/deploy.md](./docs/deploy.md)。本地试用 COS 时可以加 `--metadata local` 把元数据留在本机。

### 用真实 COS 跑端到端测试

```bash
YUNBOX_COS_E2E=1 pnpm exec vitest run packages/server/test/cos-live.test.ts
```

需要上面的环境变量。测试写在 `YUNBOX_COS_PREFIX`（默认 `yunbox-e2e`）下的随机子前缀里，结束后会删除写入的对象。GitHub Actions 里也可以手动触发 `COS E2E` 工作流，它从 `cos-e2e` environment 读取凭据和 bucket 配置。

### 用真实 CloudBase 跑元数据测试

```bash
YUNBOX_CLOUDBASE_E2E=1 YUNBOX_CLOUDBASE_ENV=<环境 ID> pnpm exec vitest run packages/server/test/metadata-live.test.ts
```

凭据和 CloudBase 服务端一样读取（`TENCENTCLOUD_*` 或 `YUNBOX_CLOUDBASE_API_KEY`）。测试使用 `yunbox_e2e_tokens`、`yunbox_e2e_grants`、`yunbox_e2e_locks`、`yunbox_e2e_audit` 四个集合（`YUNBOX_CLOUDBASE_COLLECTION_PREFIX` 可改前缀），需要事先创建，并且**只用于测试**：每个用例前后都会清空它们。

## 服务端模式

需要集中签发、吊销个人 token，或者不想给每个协作者分配 COS 子账号时，可以部署 YunBox 服务端：服务端只签发 5 分钟有效的预签名地址，素材仍由 git-lfs 直传 COS，协作者只需原版 git-lfs 和 token。下面几节都是服务端模式的说明。

### 安装命令行

用 `npm install -g yunbox` 安装（macOS、Linux、Windows 都可以，需要 Node.js 22.18+、Git 2.30+、git-lfs 3.2+）。也可以从本仓库打包安装。安装后同时得到 `yunbox` 和 `git-yunbox` 两个命令，`git yunbox <命令>` 和 `yunbox <命令>` 完全一样：

```bash
pnpm install && pnpm build
cd packages/cli && pnpm pack && npm install -g ./yunbox-0.1.0.tgz
```

Windows 上 git-lfs 通过 Git for Windows 自带的 sh 启动传输代理，需要 npm / pnpm 生成的无扩展名 `git-yunbox` 脚本在 PATH 上；`git yunbox init` 找不到它时会改写成 Node.js 的绝对路径。

发布新版本（维护者）：先在 [`docs/changelog.md`](./docs/changelog.md) 和 [`docs/en/changelog.md`](./docs/en/changelog.md) 的「未发布 / Unreleased」里写好这次的改动，再运行 `pnpm release`，它会检查两份更新日志、修改 `packages/cli` 的版本、把「未发布」标上版本号和日期、提交、打 `v*` tag 并推送；`Release` 工作流跑完全部检查后，通过 npm trusted publishing（OIDC）发布并自动附带 provenance。仓库里不保存任何 npm token：npm 只信任 `YunLeFun/yunbox` 的 `release.yml` 在 `npm` environment 里发布，包本身设置为「发布必须两步验证、禁止 token」。同一个工作流随后构建 macOS 客户端，用 `sparkle` environment 里的 `SPARKLE_ED_PRIVATE_KEY` 给更新包和 `appcast.xml` 签名，一起附在 GitHub release 上（release 说明和客户端的更新提示都取自更新日志），已安装的客户端据此自动更新（见 [macOS 客户端 README](./apps/macos/README.md#自动更新的签名)）。

`git yunbox --help` 会被 Git 改写成 `git help yunbox`（找 man 手册，会失败），查看帮助请用 `git yunbox help`、`git yunbox init -h` 或 `yunbox --help`。

### 用服务端接入一个仓库

在需要使用 LFS 的 Git 仓库里执行（示例仓库路径为 `demo/assets`，token 由管理员用 `token create` 创建后发给你）：

```bash
git yunbox init --url http://127.0.0.1:8080/demo/assets
```

它会依次完成：

1. 检查 git（2.30+）和 git-lfs（3.2+）的版本，执行 `git lfs install`。
2. 按素材类型生成或合并 `.gitattributes`：贴图和图片、设计源文件（PSD 等）、模型和动画、音频、视频、字体、压缩包。已经有规则的扩展名不会重复添加，也不会改动已有规则；已经有文件作为普通文件提交过的扩展名不加规则（会列出这些文件）；`--types texture,model` 可以只跟踪部分类型，也可以写预置组合 `game`、`design`、`media`、`all`。以后增删类型用 `git yunbox types`（见[按素材类型管理 LFS 规则](#按素材类型管理-lfs-规则)）。
3. 把 `lfs.url` 写进 `.lfsconfig`。`.lfsconfig` 只包含服务地址，命令会拒绝带用户名、密码或 token 的地址；除 `127.0.0.1`、`localhost` 以外的地址必须是 https。
4. 在本仓库设置 `lfs.locksverify=false`：Locks API 尚未实现，这是目前唯一允许关闭的检查。试点期间同一个素材同一时间只能由一个人编辑；进入多人编辑二进制素材的试点前必须补齐 Locks API。
5. 提示输入 token（输入不显示），用 `git credential approve` 存进 Git 凭据管理器（macOS 的 `osxkeychain`、Git for Windows 的 `manager` 等）。没有配置凭据管理器时会给出配置命令。也可以从标准输入传入，例如 `pbpaste | git yunbox init --token-stdin`。token 不接受命令行参数，以免留在 shell 历史里。

命令可以重复执行，已有的配置不会被破坏：`.lfsconfig` 里已经是其他地址时会停下，确认要替换再加 `--force`；凭据管理器里已有凭据时直接保留，要换 token 就加 `--token-stdin`。

然后提交配置并检查：

```bash
git add .gitattributes .lfsconfig
git commit -m "chore: 用 YunBox 管理 LFS 素材"
yunbox doctor
```

之后照常 `git add`、`git commit` 和 `git push`。token 被吊销后，git-lfs 收到 401 会让凭据管理器删除这条凭据，重新运行 `git yunbox init` 输入新 token 即可。

### 自检和用量

- `yunbox doctor` 逐项检查 git 和 git-lfs 版本、LFS 过滤器、是否在 Git 仓库里、`lfs.url`、HTTPS、`lfs.locksverify`、凭据、服务连通性，并用 download 和 upload 各发一次 batch 请求试探读写权限（不会上传或修改任何数据）。token 无效、已过期或已吊销（401）和没有权限（403）分开报告，每个失败项都附带可以直接照做的修复命令。全部通过时退出码为 0，否则为 1。只需要拉取素材的人用 `yunbox doctor --read-only`，不要求写权限。地址是非本机的 http 时，doctor 不会发送 token。
- `yunbox status` 根据 `git lfs ls-files` 列出当前提交引用的 LFS 对象数量、总大小和本地已下载的数量，以及当前生效的 `lfs.url`；`--all` 统计所有分支和历史。它不访问网络。

### 按素材类型管理 LFS 规则

`git yunbox types` 只增删 `.gitattributes` 里 YunBox 生成的那一段，手写的规则（包括 `git lfs track` 加的）不会改动，也不改历史、不提交：

| 命令 | 作用 |
|---|---|
| `git yunbox types` | 每个类型、每个扩展名现在是否走 LFS（由 `git check-attr` 判断），仓库里有多少这类文件、其中多少是 LFS 指针；并列出作为普通文件提交的素材，包括 Linux 上匹配不到小写规则的 `HERO.PNG`。`--json` 输出 schemaVersion 1，供 macOS 客户端读取 |
| `git yunbox types add model,audio` | 追加这些类型的规则。会匹配到已作为普通文件提交的文件的规则默认不加，只提示 |
| `git yunbox types add archive --renormalize` | 规则照加，并对被匹配到的已提交文件执行 `git add --renormalize`，下一次提交起改存为 LFS 指针（历史不变） |
| `git yunbox types remove video` | 删除 YunBox 为这些类型生成的规则；已经是 LFS 指针的文件只列出并给出处理办法，不自动改 |

类型有 `texture`、`source`、`model`、`audio`、`video`、`font`、`archive`；预置组合 `game`（除压缩包外的全部）、`design`（贴图、设计源文件、字体）、`media`（贴图和音视频）、`all`，可以和类型混写。`git yunbox types -h` 列出每个类型包含的扩展名。

### 手动配置

不安装命令行也可以接入，`git yunbox init` 做的就是下面这些：

```bash
git lfs install
git lfs track "*.png" "*.psd" "*.bin"
git config -f .lfsconfig lfs.url http://127.0.0.1:8080/demo/assets
git config lfs.locksverify false
printf 'protocol=http\nhost=127.0.0.1:8080\nusername=yunbox\npassword=%s\n\n' "$YUNBOX_TOKEN" | git credential approve
git add .gitattributes .lfsconfig
```

`host` 要和 `lfs.url` 的主机和端口一致。也可以第一次 push 时在提示里输入任意用户名、密码填 token，让凭据管理器记住它。

## License

[MIT](./LICENSE)

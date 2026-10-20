# 云匣 YunBox 方案计划

> 状态：方案 v2（已合并评审结论），尚未写正式代码。更新日期：2026-10-15
> 标注「未核实」的内容来自记忆或推断，实施前需要确认。

## 1. 定位

**云匣 YunBox：兼容 Git LFS 的素材托管。代码交给 Git，素材交给云匣。**

- **目标**：先做成「我们自己能可靠使用的开源工具」，服务游戏开发中的素材协作（模型、贴图、音频）。暂不按商业 SaaS 投入，也不以「npm 上缺少同类包」作为有市场的依据。
- **价值排序**：接入简单 > 可靠恢复 > 权限清楚 > 素材预览。
- **做法**：代码仍托管在 GitHub 等平台，LFS 大文件改存到对象存储（先做腾讯云 COS），解决 GitHub LFS 额度贵、国内访问慢的问题。

## 2. 背景数据

GitHub LFS 按用量计费（来源：GitHub Docs）：

| 套餐 | 免费存储 | 免费流量/月 | 单文件上限 |
|---|---|---|---|
| Free / Pro | 10 GiB | 10 GiB | 2 GB |
| Team / Enterprise Cloud | 250 GiB | 250 GiB | 4 GB / 5 GB |

超出部分：存储 $0.07/GiB/月，流量 $0.0875/GiB。clone、CI、协作者拉取都算流量，流量通常比存储先用完。

COS 参考价（**未核实**）：国内标准存储约 ¥0.118/GB/月，外网下行约 ¥0.5/GB，可以接 CDN。

## 3. 核心判断

1. **基于 Git LFS，不自研协议。** 沿用 LFS 指针文件和 SHA-256 内容寻址，兼容现有 Git 客户端、CI 和引擎插件；用户随时可以迁回其他 LFS 服务，不会被锁死。
2. **git-lfs 本来就能把文件传到第三方存储。** 客户端只通过 Batch API 和 LFS 服务器交互，服务器返回上传或下载地址，客户端直接对这个地址 PUT 或 GET。缺的只是这个服务端，所以**协作者只需要原版 git-lfs 加上仓库里的 `.lfsconfig`（`lfs.url`），不必安装 YunBox**。
3. **传输层薄，价值在体验层**：一键接入、自检、权限、文件锁、素材预览。

## 4. 架构

```
git-lfs 客户端（原版） ──Batch API / Verify / Locks──▶ YunBox 服务端
        │                                              │ 鉴权、读写权限、校验、锁
        │◀──────────── 上传或下载地址 ─────────────────┘
        └─────── PUT / GET ──────▶ 存储后端（本地文件 或 COS 私有 bucket）
```

- **第一版只做服务端模式。** 独立传输代理（`yunbox agent`，客户端直连 COS）往后放。
- **存储接口抽象出两种实现**：
  - **本地文件存储**：由服务端自己收发文件内容。协议测试和 CI 都用它，**不需要任何云端密钥**。
  - **COS**：服务端返回预签名地址，文件内容不经过服务端。
- **对象按仓库隔离**：对象键为 `<owner>/<repo>/<oid[0:2]>/<oid[2:4]>/<oid>`，第一版不做跨仓库去重。
- **仓库组织**：基于 [starter-monorepo](https://github.com/YunYouJun/starter-monorepo) 的 pnpm monorepo。`packages/core`（协议、校验、存储接口）、`packages/server`（HTTP 服务端）在 M1 实现；`packages/cli`（`yunbox` / `git-yunbox`）和 `apps/web`（素材预览）在 M3 实现。
- **命令行**：一个 npm 包同时注册 `yunbox` 和 `git-yunbox` 两个命令，后者可以用 `git yunbox ...` 调用。第一版提供 `init`、`doctor`、`status`。

### 协议约定（第一版）

| 接口 | 行为 |
|---|---|
| `POST /<owner>/<repo>/objects/batch` upload | 需要写权限。对象已存在且已校验，就不返回任何动作（客户端会跳过上传）；否则返回 `upload` 和 `verify` 两个动作，地址设置较短的有效期 |
| `POST /<owner>/<repo>/objects/batch` download | 需要读权限。**只有已校验的对象**才返回 `download` 动作；其他情况返回针对单个对象的 404 错误 |
| `POST /<owner>/<repo>/objects/verify` | 需要写权限。核对存储里的对象大小和请求中的 `size` 是否一致，一致就把对象标记为「已校验」 |
| 所有接口 | 校验 oid 必须是 64 位十六进制、`size` 不能超过上限、仓库路径格式合法；不合法时返回符合协议的错误码 |
| Locks API | 第一版不实现。客户端需要设置 `lfs.locksverify=false`，并在文档里说明。上线前必须实现，见第 6 节 M4 |

### 校验范围（需要明确，避免验收时有分歧）

- **服务端 verify 只核对大小**，用一次 HEAD 请求就能做到，成本低。
- **内容完整性（SHA-256）靠客户端**：git-lfs 下载时会核对 SHA-256，不一致会拒绝写入工作区。
- 如果需要服务端全量哈希校验，可以作为异步任务后加，第一版不做。
- 所以「损坏的上传会被拒绝」这一条的含义是：**大小不一致的上传在 verify 阶段被拒绝；内容损坏会在下载时被客户端拒绝。**

## 5. 安全设计

- **按仓库区分读写权限**；越权访问一律拒绝，不能靠猜 oid 读到其他仓库的对象（由按仓库隔离保证）。
- **共享 token 只能用于本地或协议测试，不能作为团队正式方案。** 正式方案是每人一个 token、可以单独吊销，由 Git 凭据管理器保存，以后接入统一账号体系。
- 部署时**必须用 HTTPS**（因为 Basic 认证的内容是明文）。
- **服务端不保存长期密钥**：服务绑定运行角色，由平台注入临时密钥（CloudBase 云托管的注入方式未核实，见 [deploy.md](./deploy.md)）；CAM 权限只授予对应 bucket 前缀下的 `PutObject`、`GetObject`、`HeadObject`、`DeleteObject`（删除只用于已校验标记）。
- bucket 设为私有读写，并开启费用告警。
- 地址的有效期要短；**日志脱敏**：不记录预签名地址、token、Authorization 头。
- 加上大小限制（第一版单个文件上限 2 GB）、请求超时、并发上限，并统一错误处理。
- `.lfsconfig` 只写 `lfs.url`，永远不写任何凭据。
- 不能靠关闭安全检查才能工作。唯一的例外是第一版没有锁时设置的 `lfs.locksverify=false`，而且要写进文档。

## 6. 里程碑

### M1 协议验证版

- 新建一个独立的测试仓库，使用原版 git-lfs。**先接本地文件存储**跑通 Batch API 和 verify，再接 COS。
- 验证流程：push → 在全新目录 clone → 切换到旧版本 → 恢复文件，逐个核对 SHA-256。
- 自动化测试使用真实的 git 和 git-lfs，在临时目录里运行，不依赖任何云端凭据，在 Linux CI 上跑通。
- 只做服务端模式。

### M2 安全的内部试用版

- 按仓库隔离对象；区分读写权限；只有校验通过的对象才允许下载。
- 补齐大小限制、错误处理、超时、并发、地址过期和日志脱敏。
- 每人一个 token，可以单独吊销，替代共享 token。

### M3 最小使用体验

- `git yunbox init`：检查 git-lfs → `git lfs install` → 按素材类型生成 `.gitattributes` → 写入 `lfs.url` → 配置凭据。
- `yunbox doctor`：检查环境、配置、连通性、鉴权，给出能直接照做的修复建议。
- `yunbox status`：查看当前仓库的 LFS 对象和用量。
- 一个**只读**的素材列表，加图片预览。
- 提前验证这件事：**和手动配置现有工具相比，到底能省多少事**。不要等完整后台做好了才验证价值。

### M4 真实项目试点

- 选一个游戏项目里的一小部分素材，在单独的分支上试用。
- 记录：第一次拉取的耗时、重复拉取的流量、失败后能否恢复、实际的操作步骤。
- 先在 Linux 自动化里跑通；Windows 和 macOS 实测通过后，才对外说支持跨平台。
- **文件锁**：先做单人试点；在允许多人同时编辑二进制素材之前，Locks API 必须验收通过。

## 7. 第一版暂缓

- 自动清理远端对象
- 跨仓库全局去重
- 完整的 GUI 和管理后台
- 计费系统
- 多云后端（S3、R2 等）
- 迁移已有的 LFS 历史
- 独立传输代理（`yunbox agent`）
- 超过 5 GB 的分片上传

## 8. 验收底线

- 在干净的环境里能恢复任意历史版本，所有文件的 SHA-256 都一致。
- 大小不一致的上传、越权的下载都会被拒绝；损坏的内容会在客户端下载时被拒绝。
- 重复执行同一操作不会破坏数据（幂等）。
- 中途失败后可以重试，并且能恢复到一致的状态。
- 不需要关闭安全检查就能正常工作（锁相关的例外见第 5 节）。

## 9. 与现有素材链路的关系

- **LFS 只管开发阶段的源素材**；游戏运行时的资源分发（manifest 加 CDN 等）继续沿用现有流程，两者可以共存，不互相替代。
- 有些项目目前有「禁止提交 LFS 指针」的约束，**在这些项目试点前，必须先明确调整这条约束**，不能直接替换现有的媒体链路。

## 10. 社区方案调研（2026-10 查询）

| 项目 | Star | 最近更新 | 结论 |
|---|---|---|---|
| git-lfs/git-lfs | 14.5k | 2026-10 | 核心依赖 |
| jasonwhite/rudolfs（Rust 服务端） | 524 | 2026-09 | 成熟，但需要常驻部署，是否支持锁未确认 |
| datopian/giftless（Python 服务端） | 184 | 2025-12 | 文档说暂不支持锁 |
| nicolas-graves/lfs-s3（Go 传输代理） | 141 | 2026-05 | 可以参考 |
| twilligon/git-lfs-s3-proxy（JS，跑在 Cloudflare Worker 上） | 133 | 2025-11 | 架构类似，可以参考；凭据怎么处理**未核实** |
| regen100/lfs-dal（Rust，基于 OpenDAL） | 36 | 2024-09 | 已停更 |

npm 生态：`ts-git-lfs`、`r2-lfs`、`@ferrlabs/lfsx` 等都是 2026 年才建的仓库，star 很少；`node-git-lfs` 已经废弃。可以参考，不依赖。

体验层竞品：Anchorpoint（给美术用的 Git/LFS 图形客户端，**未核实**，M3 之前试用一下，确认差异化在哪里）。

## 11. 命名

暂定 **云匣 YunBox**，副标题「兼容 Git LFS 的素材托管」。

| 候选 | 判断 |
|---|---|
| **YunBox / 云匣** | 名字描述的是价值，底层协议换了也不用改名。风险是可能被理解成网盘，用副标题和口号来消除 |
| YunLFS | 好搜，但只描述了传输层；只有当产品范围永远只做「LFS 托管服务」时才更合适 |
| YunGit | 容易被误解成 Git 托管平台；`git yungit` 读起来重复 |
| YunCrate | 开发者会联想到 Rust 的 crate |

名字占用情况：npm 上的 `yunbox` 可用；GitHub 仓库 `YunLeFun/yunbox` 可用；yunbox.com 和 yunbox.cn 已被注册。

## 12. 风险和待定问题

### M1 已定结论（2026-10-15）

- 本地对象继续使用 `<owner>/<repo>/<oid[0:2]>/<oid[2:4]>/<oid>`，不跨仓库去重。
- “已校验”状态使用对象旁的 `<oid>.verified.json` sidecar 文件，记录 oid、size、mtime 和校验时间。上传开始时先使旧标记失效，对象通过同目录临时文件原子替换；标记也通过临时文件原子替换。这样中断上传不会暴露未校验内容，重试仍然幂等。
- 本地 PUT / GET 地址使用服务进程启动时随机生成的 HMAC 密钥签名，默认 5 分钟过期；日志不记录动作地址。服务固定监听 `127.0.0.1`。
- 本轮 M1 只实现本地文件存储，不接 COS、不引入云 SDK。存储接口除流式读写和 metadata 操作外，还提供可选的 upload/download action 工厂；后续 COS 适配器可直接返回预签名动作，服务端不必代理文件内容。
- M1 选择无鉴权，只适用于本地协议测试；生产化前必须补齐 HTTPS、按仓库读写权限和可吊销的个人 token。

### G1 阶段 1 已定结论（2026-10-17）

- COS 签名自己实现（XML API v5，HMAC-SHA1），运行时不依赖官方 SDK。官方 SDK 只作为开发依赖，测试里用它交叉核对签名，COS 测试替身也用它独立重算每个请求的签名。
- 预签名 PUT 的签名只覆盖 `host` 和 `content-length`，不覆盖 Content-Type。真实 git-lfs 3.7.1 发出的请求能通过测试替身的签名校验；签名包含 `content-length`，所以大小不符的上传会被 COS 在上传阶段直接拒绝，比 verify 阶段更早。
- 「已校验」标记是对象旁的 `<oid>.verified.json` 标记对象，记录 oid、size 和校验时的 ETag。ETag 变化就等于标记失效，所以处理 upload batch 时**不再需要先删除旧标记**，标记也不需要原子替换。verify 在写标记前后各做一次 HEAD，发现对象被替换就删掉标记并返回 409。
- 下载地址的签名包含 `If-Match: <校验时的 ETag>`。已校验对象在地址有效期内被覆盖时，COS 返回 412，不会下发被替换的内容。
- 服务端对 COS 的元数据请求限制为最多 16 个并发、单次 15 秒超时；错误信息不包含地址、密钥和对象键。
- 凭据读取腾讯云标准环境变量 `TENCENTCLOUD_SECRETID`、`TENCENTCLOUD_SECRETKEY`、`TENCENTCLOUD_SESSIONTOKEN`，每次签名前重新读取，以支持运行角色轮换临时密钥。

### G1 阶段 2 已定结论（2026-10-17）

- **鉴权方式**：所有接口（batch、verify、服务端自签的 PUT / GET）都要求 HTTP Basic 认证，用户名任意，密码是个人 token。token 是 `ybx_` 加 32 字节随机数（base64url），服务端只保存 SHA-256 哈希。token 本身有 256 位随机熵，所以用一次快速哈希就够了，不需要 scrypt 之类的慢哈希。比较时对所有记录逐个用 `timingSafeEqual` 比较哈希，不提前退出。
- **HMAC 签名和 Basic 认证的关系**：两者都要通过，各管一件事。HMAC 签名证明这个动作（方法、仓库、oid、大小、过期时间）是服务端签发的，防止篡改大小或换 oid；Basic 认证证明调用者此刻仍持有一个未吊销、对该仓库有对应权限（PUT 要写、GET 要读）的 token。签名不绑定 token：有同等权限的人本来就能申请同样的地址，绑定没有额外收益；没有 token 的人拿到泄露的地址也用不了。COS 预签名地址由 COS 校验，无法要求 Basic，只能靠短有效期限制。
- **git-lfs 的实际行为**：git-lfs 3.7.1 在一个新仓库里第一次请求 batch、PUT、GET、verify 时都不带凭据，收到 401 后才从凭据管理器取 token 重试，之后把 `lfs.<url>.access=basic` 写进仓库配置，后续请求直接带凭据。服务端在读请求体之前就返回 401，git-lfs 读到提前返回的 401 后重试，e2e 用 32 MB 的首个对象覆盖了这种情况。返回 401 后连接怎么关，见下面「提前返回错误时的连接处理」。凭据错误（包括 token 被吊销）时，git-lfs 会让凭据管理器删除这条凭据。
- **越权响应**：没有凭据或 token 无效、已吊销返回 401，并带 `LFS-Authenticate: Basic realm="YunBox"`；token 有效但权限不够返回 403（只读 token 上传、对仓库没有任何权限都是 403）。不用 404 隐藏仓库，因为服务端接受任意合法的仓库路径，403 不会泄露仓库是否存在。
- **权限模型**：`repos` 的键是 `<owner>/<repo>` 或 `<owner>/*`，值是 `read` 或 `write`，`write` 包含 `read`。精确条目优先于通配条目，这样可以写出「整个 owner 可写、某个仓库只读」。
- **token 存储**：`TokenStore` 接口只有 `read` / `write` 两个方法，存一个 `{ version: 1, tokens: [...] }` JSON 文档。本地存储模式存在 `<storage-dir>/_yunbox/tokens.json`（目录 `0700`、文件 `0600`，临时文件加 rename 原子替换）；COS 模式存在 `<prefix>/_yunbox/tokens.json`。仓库 owner 必须以字母或数字开头，所以 `_yunbox` 不会和对象键冲突。文档格式不合法或读取失败时，请求一律返回 503（不回退到旧缓存，fail closed）。
- **吊销时限**：服务端缓存 token 列表 30 秒（`tokenCacheTtlSeconds`，必须小于动作地址有效期）。动作地址的过期时间从授权所用的 token 列表**开始读取的时间**算起，而不是从签发时算起，所以任何地址都会在吊销后最多 5 分钟（`actionTtlSeconds`）内过期，即使它是用 29 秒前的缓存签发的。服务端自签的 PUT / GET 每次使用都重新鉴权，吊销后最多 30 秒失效。
- **监听地址**：默认 `127.0.0.1`。监听在非回环地址时必须配置 https 的 `publicUrl`（只能是 origin，不能带路径），否则拒绝启动；动作地址和 verify 地址都基于 `publicUrl` 生成。goal.md 原本要求同时配置「可信反向代理设置」，实现时去掉了：服务端不读取任何 `X-Forwarded-*` 头（地址都来自 `publicUrl`，也不按客户端 IP 做任何判断），所以没有需要信任的代理头。以后如果要按 IP 限流或记录客户端 IP，再加这项配置。
- **M2 其余要求**：
  - 超时：batch 和 verify 整个请求 30 秒（请求体没收完返回 408，处理超时返回 503）；请求头 10 秒（Node 默认每 30 秒才检查一次，改成每秒检查）；所有连接空闲 30 秒断开。服务端自签的传输可能超过 30 秒，所以不设总时长，只靠空闲超时限制卡住的传输。
  - 并发：batch / verify 最多 32 个、服务端自签的传输最多 4 个，超出返回 503 和 `Retry-After: 1`，git-lfs 会自动重试。
  - 大小：JSON 请求体最多 1 MiB，`Content-Length` 超限时不读请求体直接返回 413；上传请求体不能超过签名里的 size，超过返回 413，比签名小的会在 verify 阶段因大小不符被拒。
  - 错误格式：所有错误（包括 404、405、408、413、503 和 Node 解析失败的畸形请求）都是 `application/vnd.git-lfs+json` 的 `{ message, request_id }`。服务端在请求体没读完时出错，不会把剩余的请求体全部读完再丢掉：请求体已经读了一部分时带 `Connection: close` 关闭连接；一点都没读时按「提前返回错误时的连接处理」延迟关闭。
  - 日志：每个请求一行 JSON，包含请求 id、方法、去掉查询串的路径、状态码、耗时和 token id；5xx 时记录脱敏后的错误名和信息（URL 换成 `[url]`，token、Basic 凭据和签名字段都替换掉）。从不记录请求头、查询串和完整地址。
- **本地存储的上传大小限制**：原来用 Transform 限制大小，超限时要等客户端断开 pipeline 才会结束，服务端发不出 413。改成在异步迭代里抛错后，超限时能立即返回 413。

### G1 阶段 3（不需要云账号的部分）已定结论（2026-10-17）

- **配置来源**：每个命令行参数都有对应的环境变量（`YUNBOX_HOST`、`YUNBOX_PORT`、`YUNBOX_PUBLIC_URL`、`YUNBOX_STORAGE`、`YUNBOX_STORAGE_DIR`），优先级是命令行参数 > 环境变量 > 默认值，空字符串等于没有设置。端口在 `YUNBOX_PORT` 之后还读 `PORT`：CloudBase 云托管官方文档说明容器内的 `PORT` 始终等于请求发到的端口，并建议优先监听它。`token` 子命令用同样的规则读取存储配置，在容器里不用重复传参。
- **配置自检**：启动前先检查端口、`publicUrl`（非回环地址必须是 https origin）、存储类型，以及 COS 的 bucket、region、prefix、endpoint 格式和 `TENCENTCLOUD_SECRETID` / `TENCENTCLOUD_SECRETKEY`。所有问题一次列出，以状态码 1 退出。错误信息只写配置项和来源（例如 `port (from PORT)`），从不写值；COS 格式错误的信息来自 `CosObjectStorage`，本身就不含值。自检不访问网络；通过后服务端从 COS 读一次 token 文档，读不到也退出（快速失败，交给平台重启）。启动日志按是否有 `TENCENTCLOUD_SESSIONTOKEN` 说明用的是临时密钥还是长期密钥，用来确认运行角色是否生效。
- **健康检查**：`GET` / `HEAD /_health` 不需要鉴权，只返回 `{"status":"ok"}`，不读存储和 token 文档，不暴露配置；其他方法返回 405。它只表示进程能处理 HTTP 请求：COS 或 token 文档暂时不可用时，batch 返回 503，但不会因为探测失败让平台反复重启实例。成功的探测不写访问日志，避免每隔几秒一行。仓库 owner 必须以字母或数字开头，所以 `/_health` 不会和 LFS 路由冲突。
- **镜像**：多阶段构建，`pnpm fetch` 按锁文件缓存依赖，构建 core 和 server 后用 `pnpm deploy --prod --legacy` 生成只含生产依赖的目录（目前只有构建产物和 `@yunbox/core`）。不用 `--legacy` 时 pnpm 要求打开 `injectWorkspacePackages`，会改变本地开发时工作区包的链接方式，所以没有采用。运行阶段以 `node` 用户运行，应用文件归 root。镜像默认 `YUNBOX_HOST=0.0.0.0` 和 `YUNBOX_STORAGE=cos`：漏配环境变量时自检会拒绝启动，而不是悄悄把素材写进容器里会丢失的本地目录。
- **部署文档**：[deploy.md](./deploy.md) 记录了 CloudBase 的创建步骤、CAM 最小权限策略、TLS 和 HTTP 检查、token 管理和 `COS E2E` 的运行方法。官方文档里查不到的平台细节一律标「未核实」，真实部署时逐项确认。

### G1 阶段 4 已定结论（2026-10-17）

- **一个包两个命令**：`packages/cli`（包名 `yunbox`，私有）的 `bin` 同时注册 `yunbox` 和 `git-yunbox`，指向同一个 `dist/cli.mjs`，两种写法行为完全一样。tsdown 的 `exports: true` 会按包名把多个 bin 合并成一个（`@yunbox/server` 的 bin 因此被改写成了 `server`），所以 CLI 在 `tsdown.config.ts` 里显式列出两个 bin，并有测试核对 `package.json`。根目录的私有包原来也叫 `yunbox`，和 CLI 重名会让 `pnpm --filter yunbox` 选错包，已改名为 `yunbox-monorepo`。
- **运行时零依赖**：`@yunbox/core` 只作为开发依赖，构建时把用到的校验函数打进 `dist`。所以 `pnpm pack` 出来的包可以直接 `npm install -g`，不需要先发布 `@yunbox/core`。参数解析用 `node:util` 的 `parseArgs`，HTTP 用全局 `fetch`。
- **输出用中文**：服务端命令（`yunbox-server`）面向管理员，保持英文；协作者用的 CLI 输出和帮助都是中文。
- **`init` 先校验后修改**：地址、素材类型和 `--token-stdin` 读到的 token 全部校验通过后，才执行 `git lfs install` 和写文件，参数错误时仓库保持原样。
- **`lfs.url` 的格式**：必须是 `<origin>/<owner>/<repo>`（末尾斜杠会去掉），owner 和 repo 用 `@yunbox/core` 的规则校验；拒绝带用户名、密码、查询参数或 `#` 的地址；除 `localhost`、`127.0.0.0/8`、`[::1]` 以外必须是 https。`.lfsconfig` 里已有不同地址时不覆盖，需要 `--force`。
- **`.gitattributes` 合并规则**：按扩展名模式（`*.png`）判断，只要已有任何规则（包括不走 LFS 的 `*.wav binary`），就不再添加，并提示哪些扩展名没有走 LFS。已有内容逐字保留，新规则沿用文件原来的换行符（CRLF 或 LF）。再次运行或增加 `--types` 时只追加缺少的规则。
- **凭据**：用户名固定写 `yunbox`（服务端忽略用户名）。token 只从标准输入或不回显的交互输入读取，命令行参数里出现 `--token` / `--password` 会直接报错。存入前检查格式（`ybx_` 开头、无空白），存入后用 `git credential fill` 读回核对。已有凭据时默认保留；换 token 时先 `reject` 旧凭据再 `approve` 新的，避免同一主机留下两条。没有配置凭据管理器时，`git credential approve` 会静默成功但什么都不保存，所以先用 `git config --get-urlmatch credential.helper` 检查，没有就报错并给出各平台的配置命令。
- **非交互地读凭据**：`doctor` 和 `init` 查询凭据时设置 `GIT_TERMINAL_PROMPT=0`、清空 `GIT_ASKPASS` / `core.askPass`，并设置 `GCM_INTERACTIVE=never` / `credential.interactive=false`，保证只读取已保存的凭据，不弹终端提示或 Git Credential Manager 的登录窗口。
- **`doctor` 的权限试探**：对 `<lfs.url>/objects/batch` 发三次请求，对象固定为 `yunbox doctor probe` 的 SHA-256（19 字节）：不带凭据的 download 判断连通性（期望 401 或 200 的 LFS JSON 响应），带 token 的 download 判断读权限，带 token 的 upload 判断写权限。upload batch 只会签发上传地址，不写任何数据，所以对 COS 存储也没有副作用。401 报告「token 无效或已吊销」，403 报告「没有权限」或「只有读权限」，并附上服务端的 message 和 request_id。不跟随重定向，避免把 token 发给其他 origin；`lfs.url` 是非本机的 http 时，跳过所有需要 token 的检查。`doctor` 只诊断，不会像 git-lfs 那样在 401 后删除凭据。
- **`doctor` 退出码**：任一项 `fail` 时为 1，`warn`（例如 `lfs.locksverify` 没设为 false）不影响退出码。只读 token 默认算失败，因为大多数接入者要推送；只需要拉取的人用 `--read-only`。
- **`status` 的数据来源**：`git lfs ls-files --json`（git-lfs 3.2.0 引入，所以最低版本定为 3.2.0），按 oid 去重统计对象数量和总大小，`downloaded` 字段给出本地已下载的数量。git 最低版本定为 2.30.0，只是测试过的下限，没有依赖更新版本的特性。
- **`git yunbox --help`**：Git 会把 `git <命令> --help` 改写成 `git help <命令>` 去找 man 手册，所以 CLI 提供 `help` 子命令，文档里写 `git yunbox help`。

### 提前返回错误时的连接处理（2026-10-17）

- **问题**：e2e 偶发 `git push` 失败，报 `LFS: Put ...: write: broken pipe`。git-lfs 在新仓库里第一次 PUT 32 MB 对象时不带凭据，服务端不读请求体就返回 401 并带 `Connection: close`，Node 发完响应后立即关闭 socket。socket 里还有没读的数据时，内核关闭连接会发 RST，客户端仍在写请求体，就会收到 EPIPE 或 ECONNRESET。Go 的 `net/http` 同时写请求和读响应，写失败和收到响应哪个先到就返回哪个，写失败先到时 git-lfs 看不到 401，也就不会带凭据重试。直接用 Go 客户端发不带凭据的 32 MB PUT，机器有负载时约 29% 的请求失败（1200 次中 345 次），修复后 1200 次全部收到 401。
- **做法：延迟关闭**：出错时如果请求体还一点都没读，服务端照常发出 LFS JSON 错误，但不带 `Connection: close`，而是继续读请求体并直接丢弃，最多丢弃 1 MiB（和 JSON 请求体上限相同）。超过后暂停读取，靠 TCP 流量控制让客户端停下来，服务端只占用 socket 自身的缓冲区，不会缓存请求体。请求体在 1 MiB 内读完时，连接可以继续用于下一个请求；否则等客户端断开，最多 5 秒后由服务端关闭。git-lfs 读到 401 后会自己关闭这个连接（Go 等待写完最多 50 ms），再带凭据重试。这和 nginx 的 `lingering_close` 是同一个思路，只是多了字节上限，暂停读取后不再丢弃数据。
- **保持不变的约束**：请求体上限不变（`Content-Length` 超限时仍然先返回 413，之后同样最多丢弃 1 MiB）；未鉴权请求最多让服务端读 1 MiB 并丢弃，不缓存；所有错误仍是 LFS JSON。请求体已经读了一部分（例如存储写入失败、JSON 流式超限、408）时保留原来的 `Connection: close`：这些情况下 Node 的请求流通常已经被销毁，或者客户端本来就没在快速写入。
- **代价**：暂停读取后，服务端看不到客户端已经断开，所以超过 1 MiB 的未鉴权上传（包括 git-lfs 的第一次 PUT）结束后，服务端仍会占用这个连接最多 5 秒，`server.close()` 也可能因此多等最多 5 秒。这比慢速发送请求头（10 秒）和空闲连接（30 秒）本来就能占用的时间短，没有增加新的资源消耗方式。
- **回归测试**：`limits.test.ts` 用原始 socket 发 256 MiB 的 PUT，确认读到 401 后 300 ms 内连接没有被关闭、5 秒后被关闭，且客户端写进去的字节有上限；另一个用例确认小请求体丢弃后同一连接还能处理下一个请求。两个用例在旧实现上都会失败（前者正是 EPIPE）。

### G2 阶段 1 已定结论（2026-10-17）

- **元数据存储接口**：`MetadataStore`（`packages/server/src/metadata.ts`）分四部分：`tokens`（创建、按 id 读取、列出、删除、记录最后使用时间）、`grants`（按用户读取、列出、原子地读改写）、`locks`（原子的「不存在才创建」、按 id 读取、按仓库和路径列出、按 id 删除）、`audit`（只有追加和列出，接口里没有修改和删除）。本阶段只接入 token 和授权；锁和审计日志的实现和契约测试已经就位，阶段 2、阶段 4 直接使用。
- **两个实现共用一层**：`DocumentMetadataStore` 建在一个很小的文档库接口 `DocumentBackend` 上（`get`、`list`（按字段相等过滤）、`create`（id 已存在就失败）、`update` / `delete`（以 etag 为条件））。每个文档带一个随机 `etag`，每次写入都换新值，条件写入失败就重读重试（带随机退避，最多 16 次）。用随机 etag 而不是递增版本号，是因为锁被删除后同一路径会重新创建，递增版本号会从头开始，旧的解锁请求可能误删新锁。
  - **本地文件版**（`metadata-local.ts`）：每个文档一个 JSON 文件，目录 `0700`、文件 `0600`。创建用 `link`（目标存在就失败，原子）；条件更新和删除持有一个文档级的锁文件（`open(..., 'wx')`），在锁内比较 etag，再用临时文件加 `rename` 原子替换。锁文件超过 10 秒视为崩溃残留，直接删除。文件名对大写字母等字符做百分号编码，`Alice` 和 `alice` 在不区分大小写的文件系统上也不会冲突。
  - **CloudBase 版**（`metadata-cloudbase.ts`）：不用 SDK，直接调用文档数据库的 HTTP API（官方文档的 OpenAPI 定义）。文档存为 `{ _id, etag, ...字段 }`；创建是带 `_id` 的插入，`409 DATABASE_DUPLICATE_WRITE` 表示已存在；条件更新是 `PATCH .../documents` 加 `query: { _id, etag }`、`$set`、`upsert: false`，看 `matched`；条件删除是 `POST .../documents/remove`，看 `deleted`。响应的 Strict EJSON 转回普通值。翻页按实际返回的条数推进，直到空页，不依赖服务端的每页上限。错误信息只含操作名、HTTP 状态、错误码和 request id，不含地址和密钥。
  - **鉴权**：照搬官方 `@cloudbase/node-sdk` 的做法：用 `TENCENTCLOUD_*` 密钥对 `POST /auth/v1/token/clientCredential` 做 TC3-HMAC-SHA256 签名换取 AccessToken，数据接口都用 `Bearer <access_token>`（文档数据库接口本来就要求 AccessToken）。token 缓存到过期前 5 分钟，`SecretId` 或 `SessionToken` 变化时重新换取，数据接口返回 401 时重新换取一次。运行角色的临时密钥可以同时用于 COS 和数据库，不需要新的长期密钥。最初的实现对每个数据请求单独签名，GET 查询串、路径编码等细节都没有依据；改成换 token 后只剩一个签名请求，形式和 SDK 逐字一致：`@cloudbase/signature-nodejs`（SDK 用的签名库）作为开发依赖，测试替身用它重算签名并要求 `Authorization` 完全相同，和 G1 用官方 COS SDK 核对签名是同一个做法。`YUNBOX_CLOUDBASE_API_KEY` 作为备用（Bearer，长期密钥），只在运行角色不能访问数据库时临时使用。
  - **不依赖未核实的插入行为**：插入后核对返回的 `insertedIds` 是不是给定的 `_id`，不是就报错；插入返回任何 409 都重新读取这个 `_id` 判断是否已存在，不依赖 `DATABASE_DUPLICATE_WRITE` 这个错误码。
  - **授权以列表存储**：一个用户的授权存成 `[{ pattern, permission }]` 而不是以仓库名为键的对象，因为仓库名可以含 `.`，文档数据库会把字段名里的 `.` 当成路径。
- **token 和授权分开**：token 新增 `user`、`expiresAt`、`lastUsedAt`，权限不再写在 token 上，而是来自这个用户的 `RepositoryGrant`（每个用户一个文档）。同一个人的多个 token 权限相同，为阶段 3「管理员按用户授权、用户自助签发 token」做准备。`token create --read/--write` 只增不减地合并进用户授权，收回权限用新增的 `grant set`。token 格式、哈希方式和 `timingSafeEqual` 逐个比较都不变。
- **过期**：默认 90 天，`--expires-in` 指定（`90d`、`12h`、`30m`，最长 3650 天）。过期在每个请求时按当前时间判断，不受 30 秒缓存影响，过期后和无效 token 一样返回 401。签发的上传、下载地址的过期时间取「快照时间 + 5 分钟」和 token 过期时间中较早的一个，地址不会比 token 活得更久。
- **最后使用时间**：认证成功后在后台写入，同一个 token 最多每小时写一次（`lastUsedWriteIntervalSeconds`，默认 3600），间隔同时参考内存里上次写入的时间和数据库里已有的值，所以重启后也不会马上再写。写入失败时清掉内存记录，下一个请求重试；写入不阻塞请求，服务关闭时等待未完成的写入。
- **吊销时限不变**：服务端每 30 秒重新读取 token 和授权；地址的过期时间仍从授权所用快照的读取时间算起，所以吊销和收回授权最迟 5 分钟完全生效，新增单元测试按时间轴核对了这个上界。
- **迁移**：`yunbox-server token migrate` 从旧的 `tokens.json`（本地或 COS）读取，每个旧 token 变成同 id、同名、同哈希的 token，用户名等于 token 名，旧 token 的仓库权限合并进这个用户的授权；旧 token 没有过期时间，统一设为迁移后 90 天。每迁移一个 token 在审计日志追加一条 `token.migrate`（actor 为 `migration`），重复执行时跳过已有标记的 token，所以迁移后被吊销的 token 不会被重新导入；中途中断时，授权合并和 token 创建都是幂等的，下次执行会补上标记。旧文件不删除。服务端启动时如果新存储里没有 token、旧文件还在，日志提示执行迁移。
- **配置**：新增 `--metadata`（`local` / `cloudbase`，COS 存储时默认 `cloudbase`，否则 `local`）和 `--metadata-dir`，以及 `YUNBOX_CLOUDBASE_ENV`、`YUNBOX_CLOUDBASE_ENDPOINT`、`YUNBOX_CLOUDBASE_COLLECTION_PREFIX`、`YUNBOX_CLOUDBASE_API_KEY`。配置自检同样只报变量名，不报值。集合由管理员事先建好，服务端不自动建。
- **测试**：`metadata-contract.ts` 是一套契约测试，同时用于本地文件版、CloudBase 测试替身和真实 CloudBase（`metadata-live.test.ts`，默认跳过）。并发用例把写入分给两个互不共享内存状态的实例（相当于两个进程）：并发签发和吊销、同一用户的并发授权修改、10 个请求争同一路径的锁（恰好一个成功）、旧锁 id 不能删掉新锁。把本地版的创建改成「先检查再写入」后，抢锁用例会失败。CloudBase 测试替身按官方 OpenAPI 的格式返回 Strict EJSON 和错误码，用官方签名库核对换取 token 的签名，数据请求只认它签发且未过期的 token，每页最多返回 7 条以覆盖翻页；另有开关模拟「重复 `_id` 换一个错误码」和「数据库不保留给定的 `_id`」。`e2e.test.ts` 的 COS 用例改为「COS 测试替身 + CloudBase 测试替身」，就是生产的组合；git-lfs 流程增加了过期 token 被拒。命令行测试覆盖了几个管理员（每条命令各自打开存储）同时签发和吊销。

### 本地推送检查已定结论（2026-10-18）

- 检查能力放在 YunBox CLI：Git thin-pack、普通文件和 LFS 候选分别统计，文件原始大小按对象去重并覆盖历史；`--json` 提供版本化接口。Workstation 仅负责 GitHub 范围和交互确认，Craft Hub 界面后续接入。
- 不查询 LFS 服务，`uploadBytes=null` 明确实际上传量未知。新分支 LFS 候选可能包含远端已有素材；用户可调整本地预算，后续可增加 Batch 存在性检查。
- **直连 COS 时查询已有对象（2026-10-20）**：直连模式（`.git/config` 登记了 `yunbox` 传输代理、仓库有 `.yunbox/config`）且本机解析到密钥时，`inspect` 对每个 LFS 候选做一次 HEAD，和传输代理上传前的检查相同，所以 `yunbox policy` 的最小权限就够，不需要列出 bucket。已存在且大小一致的不计入上传量，`remoteChecked=true`、`uploadBytes` 为确定值，LFS 预算、单文件预算和 `changes` 的上传大小都只算需要上传的对象；大小不一致的算作需要上传。并发 8、总时限 5 秒（`YUNBOX_INSPECT_REMOTE_TIMEOUT_MS` 可调，`0` 关闭），全有或全无：任一请求失败或超时就作废整次查询，回到 `uploadBytes=null` 并加一条提示，不阻止推送、不把失败当成已存在。提示只含 HTTP 状态或连接错误，不含密钥和签名地址。服务端模式仍不查询 Batch API。
- 限制：读取 macOS 钥匙串的密钥不在 5 秒时限内；钥匙串被锁时会先弹出解锁框，这和随后 git-lfs 上传时一样。
- 多个独立 Git 钩子不会在首个失败后自动停止。新增可安装、可撤销的仓库包装层，检查通过后才执行保存的原钩子；不覆盖自定义 hooksPath。其他独立上传钩子仍需各自串联。
- 限制：统计已提交内容，不扫描未提交构建目录；超出 pack 估算上限只返回下界。首次扫描大型历史可能较慢，Git 子进程有 60 秒超时、分析输出 64 MiB 上限，失败时明确阻止推送。
- 验证使用隔离 HOME 的本地 Git / git-lfs；没有访问云存储或改变 G2 的生产验收状态。使用和 JSON 字段见 [inspect.md](./inspect.md)。

### macOS 本地检查客户端（2026-10-18）

- 新增 `apps/macos`，采用 SwiftPM + SwiftUI，复用应用内的 CLI JSON，不复制体积检查算法。提供仓库选择、Git/LFS 概览、超限明细、搜索筛选、Finder 定位和 JSON 复制。
- 后台进程支持取消、120 秒超时和 64 MiB 输出限制；仓库切换通过请求标识隔离旧结果。仅本机偏好持久化，不接入服务端身份或上传功能。
- 本机包依赖 Node.js，构建脚本记录运行路径并提供设置入口。当前 ad-hoc 签名用于本机，Developer ID 公证、其他操作系统客户端和 Craft Hub 界面仍待后续。
- Swift 测试验证 JSON/退出码、未知 LFS 上传量、真实 Git/CLI、进程取消和资源限制；新增 macOS CI。此工具不改变 G2 的生产验收范围。

### 按仓库路由 COS 存储（2026-10-18）

- **配置放在服务端**：协作者只拿 `lfs.url` 和 token，COS 密钥始终只在服务端，所以「选哪个 bucket」是管理员的配置，不是客户端的。`yunbox-server cos setup` 用管理员自己的凭据（`TENCENTCLOUD_*` 环境变量，或 `tccli auth login` 写下的临时密钥）列出 bucket，交互选择已有 bucket 或新建私有 bucket，再填前缀和适用的仓库范围。
- **路由规则**：`yunbox.storage.json` 里的每条路由是 `repos`（`<owner>/<repo>`、`<owner>/*` 或 `*`）加 bucket、地域和前缀。精确匹配优先于 owner 通配，再到 `*`；没有匹配的仓库返回 404，不会落到某个默认 bucket。对象键仍是 `<prefix>/<owner>/<repo>/...`，所以多个路由共用一个 bucket 也不会共用键。文件不含密钥，也可以直接作为 `YUNBOX_STORAGE_CONFIG` 的内联 JSON 放进容器环境变量。
- **保存前探测**：`setup` 在保存前用同一组凭据在 `<prefix>/_yunbox/` 下做一次 PUT、HEAD、GET、DELETE，任一步失败就不保存；新建 bucket 前要求确认，且一律私有读写。服务端运行时用的是另一组凭据（运行角色），所以上线前要在服务端环境里跑 `cos check`。
- **兼容**：没有路由配置时，`YUNBOX_COS_BUCKET` / `REGION` / `PREFIX` 的行为不变，相当于只有一条 `*` 路由。旧版 `tokens.json` 迁移读取 `*` 路由（没有时读第一条路由）的 bucket。

### 改为默认直连 COS，不需要服务端（2026-10-18）

- **决定**：按使用者的要求，默认模式从「服务端签发预签名地址」改为「客户端用自己的密钥直连 COS」。每个协作者用 `yunbox login` 保存自己的 CAM 子账号密钥，git-lfs 通过独立传输代理（`lfs.standalonetransferagent`）调用 `git-yunbox lfs-agent`，代理直接对 COS 做 PUT / GET / HEAD，不调用任何 Batch API。服务端模式保留为可选项，代码不删。
- **取舍**：省掉了部署和运维服务端；安全边界从「服务端 token + 5 分钟地址」变为「每人一个 CAM 子账号 + 前缀级权限」，吊销靠在 CAM 里禁用密钥。代价是每个协作者都要安装 YunBox 命令行、各自持有云密钥，并且没有文件锁（Locks API 需要服务端）。
- **git-lfs 的限制（实测 3.7.1）**：`.lfsconfig` 里的 `lfs.standalonetransferagent`、`lfs.customtransfer.*` 会被当作不安全配置忽略，所以代理只能写进每份 clone 的 `.git/config`（`git yunbox init` / `clone` 负责）；`.lfsconfig` 里任何 git-lfs 不认识的键也会在每条命令上报警告，所以 COS 位置单独放在仓库根目录的 `.yunboxconfig`（git config 格式，`[cos] bucket / region / prefix`）。
- **数据可靠性**：上传前先 HEAD，已存在且大小一致就跳过；上传带 `x-cos-forbid-overwrite: true` 和签名的 `Content-Length`，不会覆盖已有对象；并发上传同一对象收到 409 时再 HEAD 确认。下载边写边算 SHA-256，大小或哈希不符就删掉临时文件并报错，不交给 git-lfs。下载的临时文件放在 `.git/lfs/tmp`，与 git-lfs 的对象目录在同一个文件系统上。
- **实测**：在私有测试 bucket `yunbox-e2e-1325586649` 上，用 `tccli auth login` 的临时密钥跑通了 init（读写探测）、推送两个版本、协作者 `git yunbox clone`、恢复旧版本（SHA-256 一致）、重复推送不重复上传；测试对象已清理。fake COS 上另外覆盖了内容被篡改时拒绝交付、无权限时不修改仓库。
- **加入已接入的仓库**：仓库里已有 `.yunboxconfig` 且没有传 `--types` 时，`init` 不改 `.gitattributes`，clone 后工作区保持干净。

### 子账号策略与钥匙串（2026-10-18）

- **`yunbox policy` 只输出不改动**：读取 `.yunboxconfig`（或 `--bucket` / `--region` / `--prefix`），打印一份策略：`name/cos:PutObject`、`GetObject`、`HeadObject`（`--read-only` 去掉 `PutObject`），资源 `qcs::cos:<地域>:uid/<APPID>:<bucket>/<前缀>/*`，APPID 取 bucket 名的数字后缀。资源六段式、`uid/<APPID>`、三个动作名和按目录授权的写法都已对照腾讯云文档（链接在 deploy.md）。不调用 CAM 接口，所以不需要管理员密钥，也不存在误改账号的风险；代价是管理员要自己在控制台粘贴和关联。
- **读写探测改为不需要删除**：原来 `init` / `doctor` 的探测是 PUT、HEAD、GET、DELETE 一个随机键，最小权限策略没有 `DeleteObject`，会让 `init` 直接失败。现在探测固定写 `<前缀>/_yunbox/probe`（内容不变，反复覆盖），只做 PUT、HEAD、GET，和传输代理实际用到的动作一致；不再删除，也就不会在多人同时探测时互相删掉对方的探测对象。COS 测试替身新增按 CAM 策略拒绝请求，端到端测试用 `yunbox policy` 的输出覆盖了：只有这份策略时 doctor、push、clone 都正常，从不发 DELETE，前缀外的 init 被拒绝，只读策略能 clone 不能 push。
- **密钥存储抽象为 `SecretStore`**：macOS 默认「钥匙串 → 0600 文件」，其他系统只有文件；`YUNBOX_CREDENTIAL_STORE=auto|keychain|file` 可以覆盖。解析顺序保持 `TENCENTCLOUD_*` > 钥匙串 > 文件 > tccli；某个存储读取失败时跳过、继续找下一个，只有全部找不到时才报这个错误。`login` 保存成功后删除其他存储里的旧副本（钥匙串成功就删除明文文件；钥匙串失败改存文件时，删除钥匙串里可能遮住新密钥的旧项）。`logout` 清理所有存储。`doctor` 在 macOS 上发现密钥还在明文文件里时给出警告。
- **钥匙串的写法**：钥匙串项是 generic password（service `yunbox`、account `cos`），内容是与文件相同的 JSON。写入时把 `add-generic-password -U … -X <十六进制>` 通过标准输入交给 `security -i`，读取用 `find-generic-password -w`，所以 SecretKey 不出现在任何进程的参数里（`-w <密码>` 会出现在 `ps` 里，`-w` 放最后又会要求终端交互，都不用）。写完立即读回比较；`security` 的错误输出在拼进提示前会去掉十六进制内容。测试通过注入的 `security` 替身检查每次调用的参数里都没有 SecretKey；`YUNBOX_TEST_KEYCHAIN=1` 时在临时钥匙串文件上跑真实 `security`，不碰登录钥匙串。所有命令行测试强制用文件存储。
- **Windows 凭据管理器暂不做**：不加依赖的办法里，`cmdkey /generic … /pass:` 要把密码放进命令行参数，而且无法读回；PowerShell 用 `Add-Type` 调 `advapi32` 的 `CredWriteW` / `CredReadW` 可以经标准输入传密钥，但每次启动传输代理都要编译一次 C#（预计 1 秒以上），在受限语言模式（AppLocker / WDAC）下不可用；`Windows.Security.Credentials.PasswordVault` 只能在 Windows PowerShell 5.1 里用，PowerShell 7 不行。都没在 Windows 上验证过，所以 Windows 继续用 `%APPDATA%\yunbox\credentials.json`，放到 G2 第 4 项 Windows 实测时再决定。

### Windows 实测与 npm 发布准备（2026-10-18）

- **Windows 用 CI 实测**：没有 Windows 机器，所以新增 `Windows` 工作流，在 GitHub 的 `windows-latest` 上用 Git for Windows 自带的 git-lfs 跑 core 和 CLI 的全部测试，包括直连 COS 的端到端流程。macOS 客户端是 SwiftUI，只能在 Mac 上运行，不在 Windows 范围内。
- **git-lfs 在 Windows 上也通过 sh 启动传输代理**（trace 里是 `sh -c 'git-yunbox lfs-agent'`），sh 不按 PATHEXT 找 `.cmd`。npm 和 pnpm 在 Windows 上会同时生成无扩展名的 sh 脚本、`.cmd` 和 `.ps1`，所以 `init` 只在找到无扩展名的 `git-yunbox` 时按命令名登记；找不到时写带引号、正斜杠的 Node.js 和脚本绝对路径，避免 `Program Files` 里的空格被 sh 拆开。
- **Windows 没有可执行位**：Node 读到的文件权限永远没有执行位，`yunbox hook install` 在 Windows 上不再检查它；Git for Windows 通过 sh 运行钩子。
- **测试沙箱**：Windows 上 `yunbox login` 的密钥文件在 `%APPDATA%`，沙箱现在把 `APPDATA` / `LOCALAPPDATA` 也指到临时目录；写进 `.gitconfig` 的路径改用正斜杠，因为 git 把反斜杠当转义。
- **npm 发布**：`yunbox` 和 `git-yunbox` 在 npm 上都没有被占用。包里 `@yunbox/core` 已打进 `dist`，没有运行时依赖；`yunbox --version` 读取包版本。发布由推送 `v*` tag 触发，用仓库 `npm` environment 里的 `NPM_TOKEN`，带 npm provenance。

### 子账号实测与 npm 首发（2026-10-18）

- **子账号实测**：用 `tccli` 临时创建一个只能编程访问的 CAM 子账号，只关联 `yunbox policy` 生成的策略（资源 `qcs::cos:<地域>:uid/<APPID>:<bucket>/<前缀>/*`），在 `yunbox-e2e-1325586649` 的随机前缀下测试。可写策略：`git yunbox init` 的读写探测、推送、协作者 clone 都通过，前缀外的 `init` 被拒绝，`yunbox buckets` 报 AccessDenied。换成只读策略后：`doctor --read-only` 通过、`doctor` 报不能写、推送新对象被拒绝、拉取已有对象正常。测试完删除了子账号（连同密钥）、两条策略和测试对象。
- **CAM 生效有延迟**：从可写切到只读后的约一分钟内，同一子账号的写请求有的被拒绝、有的仍然成功（不同 COS 节点生效时间不同）。第一次实测因此出现「检查显示只读、随后推送仍成功」；等 90 秒并连续 3 次确认拒绝后再测，结果符合预期。这是平台行为，不是代理的问题；文档里提醒开号或改权限后稍等再用。
- **npm 首发**：npm 的 trusted publishing 要在包的设置里配置，包必须先存在，所以 0.1.0 用维护者本机的 npm 登录手动发布一次（本地发布不能生成 provenance，用 `--provenance=false`）。之后用 `npm trust` 绑定 `YunLeFun/yunbox` 的 `release.yml` 和 `npm` environment，并在包设置里禁止 token 发布；以后的版本只走 OIDC，自动带 provenance。

### 首次 OIDC 发布与 life 试点（2026-10-19）

- **OIDC 发布跑通**：`yunbox@0.1.1` 由 `Release` 工作流通过 npm trusted publishing 发布，没有用任何 token，npm 记录了 GitHub 的 trusted publisher 和 provenance。包已设为 `mfa=publish`（发布必须两步验证、禁止 token）。
- **修了一个会卡住终端的缺陷**：0.1.0 的 `git yunbox init` 一开始就在标准输入上创建读取器，参数齐全、一个问题都不问时，进程在终端里不会退出。0.1.1 改为只在需要提问时才读取标准输入，并且总会关闭；回归测试会启动真实进程、保持标准输入打开，确认它能退出。这个问题只在真实终端里出现，测试替身和 macOS 应用（标准输入是空设备）都发现不了。
- **life 试点**：`YunYouJun/life` 是私有仓库，原来没有用 LFS，现在跟踪的文件里也没有大文件。接入时只跟踪模型、音频、视频（`--types model,audio,video`）：仓库里有 50 个 PNG（应用图标、Android 资源），而 CI 拉代码时不下载 LFS，如果把 PNG 也纳入 LFS 会破坏构建。COS 位置是 `yunyoujun-assets-prod-1325586649`（ap-shanghai）的 `yunbox/YunYouJun/life/`，按使用者的选择直接接入 main。
- **已知风险（使用者已确认）**：`yunyoujun-assets-prod` 的存储桶策略把整个 bucket 的读权限授予了 EdgeOne。如果这个 bucket 是某个 EdgeOne 站点的回源，知道对象键（前缀 + SHA-256）的人可以绕过子账号权限，经 CDN 下载素材。更严格的做法是换到不接 CDN 的 bucket（例如 `yunlefun-private`），或者在 EdgeOne 上屏蔽 `yunbox/` 路径。
- **CI 与 LFS**：`life` 的 CI 用 `actions/checkout` 拉代码，不下载 LFS。以后如果构建或测试要用到 LFS 里的模型，CI 需要安装 `yunbox`、配置只读子账号密钥（`yunbox policy --read-only`），并在构建前运行 `git yunbox init && git lfs pull`。

### 长期子账号密钥一条命令配置（2026-10-19）

- **问题**：`tccli auth login` 的临时密钥大约 2 小时过期，日常 push / pull 要反复登录；手动在控制台建子账号、贴策略、建密钥、`yunbox login` 步骤太多。
- **做法**：新增 `yunbox subaccount create | grant | list | delete`。只用管理员身份（`TENCENTCLOUD_*` 环境变量或 tccli 登录）调用 CAM API 3.0，签名（TC3-HMAC-SHA256）自己实现，和 tccli 自带的官方 Python SDK 结果逐字节一致，运行时仍然不依赖 SDK。子账号只能编程访问，备注标记为 YunBox 所建；策略就是 `yunbox policy` 的输出，命名为 `<子账号>-<位置哈希>-rw|ro`，同一位置重复授权会复用；中途失败会删除已建的子账号，不留半成品。`--save` 把长期密钥存进本机（macOS 钥匙串）后，用新密钥反复探测直到权限生效；`--show-key` 只显示一次，用于转交协作者。`delete` 只删除备注为 YunBox 的子账号，连同密钥和它的 YunBox 策略。
- **提醒**：`yunbox doctor` 和 `git yunbox init` 发现正在用 tccli 临时密钥时，提示换成 `yunbox subaccount create --save`。
- **实测**：在真实 CAM 上创建临时子账号、保存密钥到临时目录、等待权限生效并读写测试 bucket、`list`、`delete`，最后 CAM 里没有遗留用户和策略。真实的 `ListAttachedUserPolicies` 不返回策略描述，`list` 改为再调用 `GetPolicy` 取描述。

### 共享配置移到 `.yunbox/` 目录（2026-10-19）

- **决定**：COS 位置从仓库根目录的 `.yunboxconfig` 移到 `.yunbox/config`，格式和键不变（git config 格式，`[cos] bucket / region / prefix`）。按使用者的要求，为以后更多需要提交、共享的文件留出目录。
- **约定**：`.yunbox/` 只放提交到仓库、团队共享的文件，不放密钥、缓存和本机状态。密钥仍在钥匙串或 `~/.config/yunbox`，传输代理的登记仍在每份 clone 的 `.git/config`。服务端本地存储的默认目录 `.yunbox-data` 不变，它不在业务仓库里。
- **兼容**：新版本先读 `.yunbox/config`，没有时读旧的 `.yunboxconfig`；两个文件同时存在时必须指向同一位置，否则报错并点名两个文件，不会静默选一个，这样团队升级期间可以两份并存。`init` 只写 `.yunbox/config`，写入新位置时删除旧文件；加入已接入的仓库时不改动任何已提交的文件。`doctor` 发现旧文件时给出 `git mv .yunboxconfig .yunbox/config`（只有旧文件）或 `git rm .yunboxconfig`（两份并存）的提示，只是警告，不算失败。
- **升级顺序**：0.1.x 只认 `.yunboxconfig`，所以已接入的仓库要等协作者都升级到新版本后再迁移，或者迁移期间两份并存。

### 禁推时段（2026-10-20）

- **拦截点放在 `inspect --stdin`**：只有 pre-push 包装层传 `--stdin`，所以禁推时段只拦真实推送，手动 `inspect --push` 和 macOS 客户端不受影响；已安装的包装层升级 CLI 后自动生效，不用重装。`--guard` 模式不经过 `inspect`，`doctor` 会提示。
- **时段格式采用 OpenStreetMap `opening_hours` 的子集**（`Mo-Fr 09:00-18:00; We off`）：它是每周固定时段最通用的写法。没选 cron（GitLab Deploy freeze、Argo CD sync window 的做法），因为 cron 表示时间点，一个时段要拆成开始、结束两条；也没选 iCalendar RRULE，对每周时段过重。同一个值里 `;` 规则按 `opening_hours` 的语义后者覆盖前者，不同的值、不同位置则同时生效。节假日 `PH` 需要日历，暂不支持；「工作日」不认调休。
- **配置用多值 Git 配置 `yunbox.pushFreeze`**，三个位置同时生效：本仓库 `.git/config`、团队共享的 `.yunbox/config`、全局 `~/.gitconfig`。说明和时区（`pushFreezeMessage`、`pushFreezeTimeZone`）按位置分别设置。
- **硬拦截**：时段内 `--confirm` 不能放行；配置无效时检查失败（退出码 2），同样阻止推送，不会因为写错而悄悄放行。
- **给 AI 的接口只做 CLI**：命令都不交互、有 `--json`，任何编程助手都能直接调用；不做 MCP，避免多维护一个常驻进程。
- **快速关闭**：`yunbox freeze off [--for|--until] [--global]` 写 `yunbox.pushFreezePausedUntil`（ISO 时间或 `forever`），所有时段暂不生效、规则保留，到点自动恢复，推送时提示一句；只允许写在个人配置（本仓库或全局），读到团队 `.yunbox/config` 里的值时报错，避免一次提交关掉全队的规则。
- **风险**：`git push --no-verify` 和没装包装层的 clone 都会绕过，这只是协作约定，不是服务端强制；需要强制时只能放到托管平台（如分支保护）或以后的服务端。

### macOS 客户端自动更新（2026-10-20）

- **用 Sparkle 2**（2.10.0，SwiftPM 依赖）：macOS 上非 App Store 分发的通行方案，自带后台检查、下载、校验、替换并重启，以及中文界面。没有自己写「查 GitHub Releases 再提示下载」，因为那样仍要用户手动替换应用。
- **更新源放在 GitHub release**：每个 release 附带 `appcast.xml`，应用读 `releases/latest/download/appcast.xml`，不需要额外的服务器，也和官网下载按钮用同一个地址。release 先建成草稿，zip 和 appcast 都上传后才发布，`latest` 不会指向缺 appcast 的版本。
- **信任只靠 EdDSA**：应用是 ad-hoc 签名，每次构建的签名身份都不同，Sparkle 无法用 Apple 代码签名比对新旧版本，只能用 EdDSA。所以打开了 `SUVerifyUpdateBeforeExtraction`（解压前先验签）和 `SURequireSignedFeed`（appcast 和内嵌的更新说明也要签名），更新源被篡改时既装不上，也改不了展示给用户的内容。公钥写在 `script/build_and_run.sh`，私钥只在维护者钥匙串（account `fun.yunle.yunbox`）和 GitHub `sparkle` environment 的 `SPARKLE_ED_PRIVATE_KEY` 里。发布脚本会用应用里的公钥核对 zip 的签名，密钥配错时发布失败，而不是发出没人能装的更新。
- **版本号**：`CFBundleVersion` 改为和 `CFBundleShortVersionString` 一样取 CLI 的版本（以前固定为 `1`），Sparkle 用它比较新旧。
- **风险**：私钥丢失后无法轮换（轮换需要 Developer ID 签名的 dmg），已安装的客户端只能手动下载新版本；要妥善备份。0.1.4 及以前的客户端没有 Sparkle，要手动更新一次。以后换成 Developer ID 签名和公证时，应用的签名身份会变，Sparkle 仍然靠 EdDSA 放行这次更新。
- **分发方式（2026-10-20 决定）**：不上 Mac App Store，也暂不做 Developer ID 签名和公证。App Store 要求 App Sandbox，而客户端要调用用户自己的 Node.js、git、git-lfs，读写任意仓库和 `~/.gitconfig`、安装 pre-push 钩子，沙盒里都做不到；审核规则也不允许 Sparkle 这类自带更新机制。Developer ID 和公证需要付费的 Apple Developer Program，目前继续用 ad-hoc 签名加 Sparkle：用户第一次打开要在「隐私与安全性」里放行，之后的更新会去掉隔离标记，不再提示。代价是进不了 Homebrew 官方 cask（正在下架没有签名和公证的 cask）。将来有了以云乐坊名义注册的开发者账号，再在发布流程里加上签名、Hardened Runtime 和 `notarytool`，已安装的客户端可以直接更新过去。

### macOS 客户端中英文界面和更新日志（2026-10-20）

- **源语言是简体中文**：界面文字直接写在代码里，英文放在 Xcode 字符串目录 `apps/macos/Localization/Localizable.xcstrings`。没有 Xcode 工程，所以用编译器的 `-emit-localized-strings` 提取文字、`xcstringstool sync` 合并进目录（Xcode 也是这样做的），`xcstringstool compile` 在打包时生成 `en.lproj`；`script/sync_strings.sh --check` 在 CI 里保证目录不过期、每条都有英文。字符串放在 `Bundle.main` 而不是 SwiftPM 的 `Bundle.module`，所以 SwiftUI 的文字字面量不用改写就能本地化。`CFBundleDevelopmentRegion` 是 `zh-Hans`：系统语言既不是中文也不是英文时显示中文。
- **语言切换用系统机制**：设置里的选择写入应用自己的 `AppleLanguages`，与系统设置的「应用程序语言」是同一个值，读取时只看应用自己的域，不受系统语言列表影响；重新打开后生效。Sparkle 的界面跟着同一个设置切换。
- **更新日志两份**：`docs/changelog.md` 和 `docs/en/changelog.md`，Keep a Changelog 的格式，顶部是「未发布」。`pnpm release` 先检查两份都写了未发布的改动，bumpp 改版本号时把它们标上版本号和日期，和版本号同一个提交（只提交这几个文件）。发布工作流用对应版本的两段说明生成 GitHub release 说明，并以 `<description xml:lang>` 写进 appcast，Sparkle 按应用语言显示；appcast 改动后用 `sign_update` 重新签名。没有从提交记录自动生成，是因为提交信息是给开发者看的英文，更新提示要的是给用户看的中英文说明。
- **还没做**：命令行输出、官网文档（除更新日志）仍只有中文；客户端显示的 `doctor` 检查项等来自命令行的文字在英文界面里也是中文。

### 后续风险

- CloudBase 云托管绑定运行角色后是否以 `TENCENTCLOUD_*` 环境变量注入临时密钥**未核实**（云函数是这样做的）。如果不是，需要在服务端增加从平台元数据接口获取密钥的代码，或者临时改用只挂最小权限策略的子账号长期密钥。
- 临时密钥的有效期和预签名地址：预签名地址用签发时的临时密钥签名，密钥过期后地址也失效。如果平台只在容器启动时注入一次密钥、运行中不更新环境变量，服务会在密钥过期后整体失效；即使会更新，临近过期时签发的地址也可能不到 5 分钟就失效。需要在真实环境里确认密钥的有效期和刷新方式，必要时在签名前检查剩余有效期。
- 服务端看不到客户端用的是 http 还是 https（不读 `X-Forwarded-Proto`），明文 HTTP 能否到达服务完全取决于 CloudBase 入口。部署时要按 deploy.md 用 `curl http://...` 确认会跳转或被拒绝；如果入口会转发明文 HTTP，就只能靠所有人的 `lfs.url` 写 https。
- CloudBase 路由的网关鉴权如果开启，可能会占用 `Authorization` 头，导致 git-lfs 的 Basic 认证失效，必须保持关闭（**未核实**）。
- CloudBase 健康检查的探测方式和路径文档里没有写。如果只有 TCP 探测，事件循环卡死时实例不会被重启；镜像里的 Docker `HEALTHCHECK` 是否被平台使用也**未核实**。
- 基础镜像固定到 `node:24.22.0-bookworm-slim` 的多架构索引摘要，由 Dependabot 每周提出更新。合并这类更新前要确认 CI 和镜像构建通过；Dependabot 不会自动重新构建已部署的镜像。
- 真实 COS 已部分实测（2026-10-18）：在私有测试 bucket `yunbox-e2e-1325586649`（ap-guangzhou）上，用 `tccli auth login` 的临时密钥跑通了 `cos-live.test.ts`，也就是真实 git-lfs 通过预签名 PUT（签名包含 `content-length`）上传、带签名 `If-Match` 的预签名 GET 下载、临时密钥放在 `x-cos-security-token` 查询参数里，以及推送、全新 clone、恢复旧版本和重复推送；测试结束后 bucket 为空。`cos setup` 在真实 COS 上新建私有 bucket 和读写探测也通过了。还没验证的是：CAM 最小权限策略（这次用的是主账号登录的临时密钥，权限比服务端运行角色大）、运行角色注入的密钥，以及 CloudBase 元数据。
- ~~token 文档没有并发保护：两个管理员同时执行 `token create` / `revoke` 时，后写入的会覆盖先写入的。~~ **已解决（G2 阶段 1）**：token 改存元数据存储，每个 token 一个文档，授权修改以 etag 为条件重试，契约测试和命令行测试覆盖了并发签发、吊销和授权修改。
- ~~token 文档和对象放在同一个 bucket 里。~~ G2 阶段 1 起 token 在文档数据库里，不再和对象共用 COS 权限；但运行角色仍然能读写全部元数据，服务端被攻破时 token 哈希会暴露（哈希不能反推出 token）。
- 吊销时限依赖每个实例自己的缓存，多实例部署时每个实例都满足 5 分钟的上界；但 CloudBase 文档数据库写入后立刻查询是否一定能读到（强一致）**未核实**，要在真实环境确认。
- git-lfs 在新仓库里的第一次上传会先不带凭据发送，收到 401 后重试。服务端会在读请求体之前拒绝并断开连接，但客户端可能已经通过网络发出了一部分请求体；大文件的首次 push 会因此多花一点流量。COS 直传模式下上传地址不经过服务端，没有这个问题。
- Basic 认证的内容是明文，公网部署时 TLS 必须在 CloudBase 的入口终止，服务端只监听容器内部地址。阶段 3 的部署文档给出了检查方法，但还没有在真实环境确认 CloudBase 云托管会不会把明文 HTTP 请求转发给服务（见上面关于 `X-Forwarded-Proto` 的风险）。
- ETag 在单次 PUT 时是内容的 MD5。有写权限的人理论上可以用 MD5 碰撞构造同样大小、同样 ETag 的不同内容，在地址有效期内覆盖已校验对象；这种情况由客户端下载时的 SHA-256 校验兜底，第一版不做服务端哈希校验。
- 多条路由指向不同 bucket 时，服务端的运行角色要能访问所有 bucket 的对应前缀；CAM 策略写漏一条，只有那条路由的仓库会失败。`cos check` 能发现，但要记得在服务端环境里运行。
- `tccli auth login` 的临时密钥大约 2 小时过期，只适合用来做 `cos setup`，不能当作服务端的运行凭据。
- 直连模式下每个协作者都持有云密钥。密钥泄露的影响范围取决于 CAM 策略写得多严。~~需要给出可直接复制的子账号策略模板~~ **已提供 `yunbox policy`**（2026-10-18），但它只输出不改动 CAM，管理员可能关联错策略或给了 `cos:*` 这类更宽的预设策略，YunBox 发现不了（子账号通常没有读取自身策略的权限）。用这份策略的真实子账号**还没在真实 bucket 上实测**，试点开始前要补上：`doctor`、push、clone 各一次。
- 有写权限的子账号仍然可以不带 `x-cos-forbid-overwrite` 直接覆盖已有对象（传输代理不会这样做，但泄露的密钥可以）。下载时的 SHA-256 校验能发现被替换的内容，但内容本身要靠 COS 版本控制找回。可以给 `PutObject` 加 `cos:x-cos-forbid-overwrite` 条件（**未实测**），但腾讯云文档说开启版本控制的 bucket 上这个请求头不生效，而且探测对象需要覆盖，所以暂不加进 `yunbox policy`。
- 探测对象 `<前缀>/_yunbox/probe` 会一直留在 bucket 里（20 字节）。开启版本控制后每次 `init` / `doctor` 都会多一个历史版本，由历史版本的生命周期规则清理。
- 钥匙串项信任 `/usr/bin/security`，读取不弹窗，因此同一用户下的任何程序都能用 `security find-generic-password -s yunbox -a cos -w` 读到密钥。钥匙串只解决「明文文件被备份、同步、误传」的问题，不防本机恶意程序；要防就得用 `-T ""` 让每次读取都弹窗，git-lfs 每次 push / pull 都会触发，不现实。
- 钥匙串被锁住（例如通过 SSH 登录、或屏幕锁定后）时，读取会失败或弹出解锁窗口。读取失败会回退到文件，没有文件就报错并提示 `YUNBOX_CREDENTIAL_STORE=file`；弹窗时传输代理会一直等到用户操作（最多 120 秒）。只在临时钥匙串上自动测试过，登录钥匙串的实际弹窗行为没有在 CI 里覆盖。
- `git-yunbox` 必须在 PATH 上，git-lfs 才能启动代理。GUI Git 客户端（如 Fork、SourceTree）的 PATH 可能和终端不同；`init` 在找不到命令时会写入 Node.js 和脚本的绝对路径，但升级 Node.js 后要重新运行 `git yunbox init`。
- 直连模式没有文件锁，多人同时编辑同一个二进制素材时只能靠约定。
- ~~密钥文件是明文 JSON（权限 600）。~~ macOS 已改存钥匙串（2026-10-18）；Linux 和 Windows 仍是明文 JSON（Windows 上 600 权限位不起作用，靠 `%APPDATA%` 默认的用户目录权限）。Linux 可以用 libsecret 的 `secret-tool store`（从标准输入读密码），但很多服务器和 CI 没有 Secret Service，暂不做。
- Windows 上 GUI Git 客户端（Fork、SourceTree、GitHub Desktop）自带或调用的 sh 和 PATH 可能找不到 `git-yunbox`；还没实测。找不到时重新运行 `git yunbox init` 会改写成绝对路径。
- Windows 下 npm 生成的 `git-yunbox` shim（`git-yunbox.cmd`、`git-yunbox.ps1` 和无扩展名的 sh 脚本）能否被 Git for Windows 的 `git yunbox` 找到，**仍未实测**；自动测试只在 macOS / Linux 上用 sh shim 验证了 `git yunbox` 和 `yunbox` 输出一致。阶段 5 要在 Windows 上实测，不行就改用 Node SEA 或 `bun build --compile` 打成单个可执行文件。
- 命令行目前只能从仓库 `pnpm pack` 后 `npm install -g` 安装，协作者需要 Node.js 22.18+。npm 包名和发布方式还没定；如果试点里有人没有 Node.js，就需要单文件可执行程序。
- `.gitattributes` 只生成小写扩展名的规则（`*.png`）。Linux 和 CI 上 Git 默认区分大小写，`HERO.PNG` 这类文件不会走 LFS，会作为普通文件提交进 Git 历史。macOS 和 Windows 上 `core.ignorecase=true` 时能匹配。如果试点素材里常见大写扩展名，要考虑生成 `*.[pP][nN][gG]` 这种规则，或在 `doctor` 里检查已提交的非 LFS 大文件。
- `doctor` 在 Windows 上给出的修复命令里有 `printf ... | git credential reject` 和 `curl`，在 PowerShell 和 cmd 里不能直接照做，Git Bash 里可以。Windows 实测时要决定是否按平台输出不同的命令。
- `init` 的交互输入在 Windows 终端（尤其是 Git Bash 的 mintty）里能否进入 raw 模式、是否会回显，需要实测；不行时可以用 `--token-stdin`。
- 凭据只按 `protocol` + `host` 保存。用户设置了 `credential.useHttpPath=true` 时，git-lfs 查询凭据会带上路径，可能找不到 `init` 存的凭据；`doctor` 也按 host 查询，所以这种情况下 `doctor` 通过而 push 仍会提示输入。
- Locks API 需要持久化存储：G2 阶段 1 已提供 `LockRepository`（原子创建、按 id 删除），锁不过期、强制解锁只允许管理员已在 goal-g2.md 定下，接口在阶段 2 实现。
- 对象清理需要扫描仓库历史，确认对象已经没有任何提交引用，第一版不做。
- **G2 阶段 1 新增**：CloudBase 文档数据库还有几处**未核实**，只能在真实环境确认（阶段 0 用 `metadata-live.test.ts`）：需要哪些 CAM 权限、能否限定到单个环境；用密钥换取的 token 是否按管理员处理（否则条件更新和删除匹配不到文档，契约测试会失败）；插入时能否自己指定字符串 `_id`（不能时插入直接报错，锁要改成在单独字段上建唯一索引）。签名细节、重复错误码、每页上限已经不再依赖（见上面的结论）。
- **G2 阶段 1 新增**：运行角色的临时密钥能否用于 CloudBase HTTP API **未核实**。不行时只能临时改用 `YUNBOX_CLOUDBASE_API_KEY`，这是长期有效的管理员密钥，违背「运行时不使用长期密钥」，要在阶段 6 安全复查前解决。
- **G2 阶段 1 新增**：token 名称的唯一性只是签发前查一次，不是原子的；两个管理员同时用同一个名称签发会得到两个同名 token，这时 `token revoke <名称>` 会拒绝并列出 id。用户名（授权文档的 id）是原子唯一的。
- **G2 阶段 1 新增**：翻页用 offset，查询期间有文档被删除时可能漏掉一条。服务端每 30 秒全量读取一次 token 和授权，被漏掉的 token 会在这 30 秒内返回 401（git-lfs 会删除这条凭据）。30 人规模下 token 总数远小于一页（100 条），基本不会翻页；token 多到需要翻页时，再改成按 `_id` 游标翻页。
- **G2 阶段 1 新增**：每次重新读取快照都要列出全部 token 和授权（每个实例每 30 秒两次查询）。规模变大后可以改成按 token 哈希直接查一个文档，但要重新论证吊销时限。
- **G2 阶段 1 新增**：本地文件版的锁文件超过 10 秒就被当作崩溃残留删除。持有锁的操作只有几毫秒，但机器极慢（例如磁盘卡住超过 10 秒）时，两个写入者可能同时进入临界区。本地版只用于开发和测试。
- **G2 阶段 1 新增**：迁移后的旧 token 统一在迁移后 90 天过期。管理员要在此之前给每个人换发新 token，否则大家会在同一天收到 401；`token list` 会显示过期时间。

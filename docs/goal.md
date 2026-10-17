# 目标 G1：真实可用版

> 状态：已确认（决策表采用推荐默认值）。日期：2026-10-17
> 前置：M1 协议验证版已完成（见 [plan.md](./plan.md) 第 12 节）。本文件取代 AGENTS.md 中 M1 的范围限制（例如「必须监听 127.0.0.1」「不接 COS」）；plan.md 第 5 节安全设计和第 8 节验收底线仍然全部有效。

## 一句话目标

**一个小团队（≤ 5 人）在一个真实游戏仓库里，用 YunBox + 腾讯云 COS 取代 GitHub LFS 存放素材，协作者只需要原版 git-lfs 和一个个人 token。**

## 「真实可用」的完成标准

全部满足才算完成：

1. **公网可用**：服务端以 HTTPS 部署在固定域名上，素材经 COS 预签名地址直传，文件内容不经过服务端。
2. **身份可控**：每人一个 token，可单独吊销；按仓库区分读、写权限；吊销后最迟在动作地址有效期（默认 5 分钟）结束后失去访问能力。
3. **接入简单**：在一个新仓库里执行 `git yunbox init`，5 分钟内能完成首次 push；`yunbox doctor` 能指出常见配置错误，并给出可直接照做的修复命令。
4. **数据可靠**：在真实 COS 上通过 plan.md 第 8 节全部验收底线，即任意历史版本可恢复、SHA-256 一致、幂等、中断可重试、越权和大小不一致被拒绝。
5. **真实试点**：在一个真实项目的独立分支上用满 2 周，记录首次拉取耗时、重复拉取流量、失败恢复情况和实际操作步骤，结论写进 plan.md 第 12 节。
6. **跨平台**：macOS 和 Windows 上实测 clone、push、checkout 旧版本；Linux 由 CI 覆盖。
7. **CI 不依赖云端凭据**：真实 COS 测试作为单独、手动触发的工作流，默认跳过。

## 已定决策

2026-10-17 确认采用下表的推荐默认值：

| 决策 | 结论 | 理由 |
|---|---|---|
| 部署平台 | 腾讯云 CloudBase 云托管（容器），与已有的云乐坊 CloudBase 环境放在一起 | 现有 `node:http` 服务可以直接放进容器运行，不用改写成函数入口；可以绑定运行角色、自动注入临时密钥（**未核实**，开工前确认） |
| COS 签名 | 自己实现 COS XML API v5 的请求签名，不引入官方 SDK | 只需要预签名 PUT/GET 和 HEAD，签名算法是 HMAC-SHA1，代码量小；符合「依赖尽量少」的约定 |
| token 存储 | 存成私有 COS 前缀下的一个 JSON 文件，只保存 token 的哈希值；用管理命令维护 | 不引入数据库；token 数量在两位数以内 |
| 统一账号（云乐坊 SSO） | 不在 G1 内 | 个人 token 已经能满足小团队使用；SSO 放到后续目标 |
| 文件锁（Locks API） | 不在 G1 内，试点期间每个素材同一时间只有一人编辑，文档写明 | plan.md 规定在允许多人同时编辑二进制素材之前，必须先验收锁；锁单独作为 G2 |
| 试点仓库 | 待定 | 需要你指定一个项目，以及其中的一小部分素材 |

## 阶段

每个阶段单独提交 PR，并保持 `pnpm build && pnpm lint && pnpm typecheck && pnpm test` 全部通过。

### 阶段 1：COS 存储后端（预签名直传）

- `packages/core` 新增 COS 存储实现：通过已有的 `createUploadAction` / `createDownloadAction` 返回预签名 PUT/GET，`verifyObject` 用 HEAD 核对大小。
- 「已校验」标记：在对象旁写一个标记对象，记录 size 和 ETag。下载前用 HEAD 核对 ETag，防止已校验的对象在地址有效期内被覆盖。处理 upload 类型的 batch 请求时，如果对象还没校验，就先删除旧标记。
- 先验证 plan.md 第 12 节的风险：git-lfs basic 传输发出的请求头（如 Content-Type）能否和 COS 预签名的签名匹配。签名只覆盖 host 时，要确认不会影响安全性。
- 用 mock 或本地测试 COS 签名向量的单元测试进 CI；另提供手动触发的真实 COS 端到端测试，复用 M1 的 e2e 场景，使用专用 bucket 和前缀。
- 单文件上限仍为 2 GB（单次 PUT），不做分片上传。

### 阶段 2：鉴权与权限

- Basic 认证：用户名任意，密码是个人 token，由 Git 凭据管理器保存。token 用随机数生成，服务端只保存哈希值，比较时用定时安全比较。
- 权限模型：`token → { name, repos: { "<owner>/<repo>": "read" | "write" } }`，支持通配 `<owner>/*`。
- 管理命令：`yunbox-server token create | list | revoke`，只在部署环境或管理员本机执行，创建时只输出一次明文 token。
- 监听地址改为可配置。监听在 127.0.0.1 以外时，必须同时配置 `publicUrl`（https）和可信反向代理设置，否则拒绝启动。
- 补齐 M2 的其余要求：请求超时、并发上限、请求体大小限制、统一错误格式、日志脱敏（不记录 token、Authorization 头、预签名地址），并为每条要求写测试。

### 阶段 3：部署

- 新增 Dockerfile 和部署文档：运行角色的 CAM 权限只授予 `PutObject`、`GetObject`、`HeadObject`、`DeleteObject`（删除只用于标记对象），bucket 私有读写，开启费用告警。
- 配置全部来自环境变量，`.lfsconfig` 只写 `lfs.url`。
- 健康检查接口，以及启动时的配置自检（缺少什么就明确报错）。
- 部署到测试环境，在真实 COS 上跑通阶段 1 的手动 e2e。

### 阶段 4：命令行（M3 的最小部分）

- 新建 `packages/cli`，一个包同时注册 `yunbox` 和 `git-yunbox`。
- `git yunbox init --url <服务地址>`：检查 git-lfs → `git lfs install` → 按素材类型生成 `.gitattributes` → 写入 `.lfsconfig` 的 `lfs.url` → 设置 `lfs.locksverify=false` 并说明原因 → 引导把 token 存进凭据管理器。
- `yunbox doctor`：检查 git、git-lfs 版本、`lfs.url`、HTTPS、凭据、连通性、读写权限，每个失败项都附修复命令。
- `yunbox status`：列出当前仓库的 LFS 对象数量和总大小。
- 只读的素材预览网页（`apps/web`）不在 G1 内。

### 阶段 5：试点与跨平台

- 在试点仓库的独立分支上接入，团队成员按 README 自行完成接入，记录卡住的地方并修文档或修 `doctor`。
- 在 macOS 和 Windows 上实测，重点检查 Git for Windows 能否识别 npm 生成的 `git-yunbox` shim（plan.md 第 12 节风险）。
- 试点结束时，把数据和结论写进 plan.md 第 12 节，并决定是否进入 G2（文件锁、SSO）。

## 不在 G1 内

plan.md 第 7 节「第一版暂缓」的全部内容，以及：文件锁、云乐坊 SSO、素材预览网页、迁移已有 LFS 历史、多 bucket 或多地域。

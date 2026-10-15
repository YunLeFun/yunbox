# AGENTS.md

云匣 YunBox：兼容 Git LFS 的素材托管。完整方案见 [docs/plan.md](./docs/plan.md)，动手前先读第 3–8 节。

## 当前目标：M1 协议验证版

只做 `docs/plan.md` 第 6 节 M1 的范围，第 7 节「第一版暂缓」中的内容一律不做。

### 要交付

1. **LFS 服务端**（Node + TypeScript），实现第 4 节「协议约定」：
   - `POST /<owner>/<repo>/objects/batch`（upload / download，`transfer: basic`）
   - `POST /<owner>/<repo>/objects/verify`（只核对大小，通过后标记为已校验）
   - 仅已校验的对象可下载；对象键按仓库隔离；校验 oid、size、仓库路径；单文件上限 2 GB
   - 响应和错误格式符合 [Git LFS Batch API](https://github.com/git-lfs/git-lfs/blob/main/docs/api/batch.md)
2. **存储接口**，先只实现**本地文件存储**：服务端自己提供 PUT/GET 地址并收发内容。接口要能后续接 COS 预签名，但本里程碑不接 COS、不引入任何云 SDK。
3. **端到端测试**（vitest）：用真实的 `git` 和 `git-lfs`，在临时目录中启动服务端，覆盖：
   - push → 全新目录 clone → 文件 SHA-256 与原文件一致
   - 修改素材再提交 → checkout 旧版本 → 恢复出旧文件且 SHA-256 一致
   - 重复 push 幂等；中断后重试能成功
   - 大小不一致的上传在 verify 被拒绝；未校验对象不可下载；越界的仓库路径和非法 oid 被拒绝
4. **CI**：GitHub Actions，Linux 上安装 git-lfs 并跑全部测试。不得依赖任何云端凭据。

### 约束

- ESM、严格 TypeScript；pnpm；vitest；lint 用 `@antfu/eslint-config`（不分号、单引号）。
- 依赖尽量少，HTTP 层优先用 `node:http` 或极轻量框架。
- 本里程碑只有本地测试用的固定 token 或无鉴权，**必须监听 127.0.0.1**，并在 README 标明不可用于生产。
- 日志不得输出 token、Authorization 头和完整的上传或下载地址。
- 测试客户端可以设置 `lfs.locksverify=false`（Locks API 不在 M1 范围），除此之外不得通过关闭安全检查让测试通过。
- 不提交任何凭据、`.env` 或内部项目信息。

### 完成标准

- `pnpm install && pnpm lint && pnpm typecheck && pnpm test` 在本地和 CI 全部通过。
- README 补充：本地启动服务端、在测试仓库配置 `lfs.url` 的步骤。
- 在 `docs/plan.md` 第 12 节记录 M1 中定下的结论（例如「已校验」标记的存储方式），以及发现的新风险。

# AGENTS.md

云匣 YunBox：兼容 Git LFS 的素材托管。完整方案见 [docs/plan.md](./docs/plan.md)，动手前先读第 3–8 节。

## 仓库组织：基于 starter-monorepo

使用 [YunYouJun/starter-monorepo](https://github.com/YunYouJun/starter-monorepo) 模板（pnpm workspace + catalog、tsdown、vitest、@antfu/eslint-config、VitePress 文档）。

初始化方式：把模板 clone 到临时目录，运行它的 `scripts/init.mjs`（`--project-name yunbox --package-name @yunbox/core --description "兼容 Git LFS 的素材托管" --repository https://github.com/YunLeFun/yunbox --author YunYouJun --dir <临时目录>`），再把生成结果合并进本仓库。合并时**保留本仓库已有的 `README.md`、`AGENTS.md`、`LICENSE`、`docs/plan.md`**（README 可以补充开发命令），模板自带的 `CLAUDE.md` 改成指向 `AGENTS.md`。

包规划（M1 只建前两个，都设为 `"private": true`，npm 包名以后再定）：

| 目录 | 包名（暂定） | 职责 | 里程碑 |
|---|---|---|---|
| `packages/core` | `@yunbox/core` | LFS 协议类型、oid/size/仓库路径校验、存储接口、本地文件存储实现 | M1 |
| `packages/server` | `@yunbox/server` | HTTP 服务端（Batch、Verify、本地存储的 PUT/GET） | M1 |
| `packages/cli` | `yunbox` | `yunbox` / `git-yunbox` 命令：init、doctor、status | M3 |
| `apps/web` | — | 只读素材列表和图片预览 | M3 |

模板里用不到的部分（`pkg-placeholder`、`apps/web` 示例等）删掉，M3 时再按需加回来。端到端测试放在 `packages/server/test/` 或根目录 `test/e2e/`，二选一并在 README 说明。

## 当前目标：G1 真实可用版

见 [docs/goal.md](./docs/goal.md)。其中的范围取代下面 M1 一节的限制；M1 一节的代码约定（ESM、`catalog:`、tsdown、JSDoc、日志脱敏等）继续有效。

## 已完成：M1 协议验证版（2026-10-15）

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

- 遵循 starter-monorepo 的约定：ESM、严格 TypeScript、`catalog:` 统一依赖版本、tsdown 构建、vitest、`@antfu/eslint-config`（不分号、单引号）、公开 API 写 JSDoc。
- 依赖尽量少，HTTP 层优先用 `node:http` 或极轻量框架。
- 本里程碑只有本地测试用的固定 token 或无鉴权，**必须监听 127.0.0.1**，并在 README 标明不可用于生产。
- 日志不得输出 token、Authorization 头和完整的上传或下载地址。
- 测试客户端可以设置 `lfs.locksverify=false`（Locks API 不在 M1 范围），除此之外不得通过关闭安全检查让测试通过。
- 不提交任何凭据、`.env` 或内部项目信息。

### 完成标准

- `pnpm install && pnpm build && pnpm lint && pnpm typecheck && pnpm test` 在本地和 CI 全部通过。
- README 补充：本地启动服务端、在测试仓库配置 `lfs.url` 的步骤。
- 在 `docs/plan.md` 第 12 节记录 M1 中定下的结论（例如「已校验」标记的存储方式），以及发现的新风险。

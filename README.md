# 云匣 YunBox

> 兼容 Git LFS 的素材托管。代码交给 Git，素材交给云匣。

**状态：G1 阶段 2（鉴权与权限）已完成，尚未部署到公网，也未在真实 COS 上实测。**

YunBox 是一个 Git LFS 服务端：代码仍托管在 GitHub 等平台，LFS 大文件存到你自己的对象存储（先支持腾讯云 COS）。协作者只需原版 [git-lfs](https://git-lfs.com) 和仓库里的 `.lfsconfig`，不必安装 YunBox。

- 方案与里程碑：[docs/plan.md](./docs/plan.md)

## 当前能力

- Git LFS Batch API：upload / download，`transfer: basic`
- Verify API：核对对象大小并持久化“已校验”状态
- 仓库隔离的本地文件存储，以及由服务端提供的签名 PUT / GET 地址
- 腾讯云 COS 存储：服务端只签发预签名地址，素材由 git-lfs 直接上传到 COS、从 COS 下载，不经过服务端
- 个人 token 鉴权（HTTP Basic，用户名任意，密码是 token），按仓库区分读写权限，可单独吊销
- 请求超时、并发上限、请求体大小限制、统一的 LFS JSON 错误格式、脱敏的访问日志
- 真实 `git` 和 `git-lfs` 端到端测试（通过 Git 凭据管理器提供 token）

默认只监听 `127.0.0.1`。监听其他地址时必须用 `--public-url` 配置 https 地址，否则拒绝启动；Basic 认证的内容是明文，**公网部署必须经过 HTTPS**。部署方式见 [docs/goal.md](./docs/goal.md) 阶段 3，在那之前不要把服务暴露到其他网络。

## 开发

需要 Node.js 22.18+（推荐读取 `.node-version` 使用 Node.js 24）、pnpm 和原版 `git-lfs`。

```bash
pnpm install
pnpm build
pnpm lint
pnpm typecheck
pnpm test
```

工作区目前包含两个私有包：

- `packages/core`：LFS 协议类型、输入校验、存储接口、本地文件存储和 COS 存储
- `packages/server`：基于 `node:http` 的 Batch、Verify、PUT 和 GET 服务

端到端测试位于 `packages/server/test/`：`e2e.test.ts` 分别用本地存储和一个 COS 测试替身（`packages/core/test/fake-cos-server.ts`，用官方 SDK 重新核对每个签名）跑同一套 git-lfs 流程（`lfs-workflow.ts`），不需要任何云端凭据。流程通过 `credential.helper store` 把 token 交给 git-lfs，并覆盖只读 token 不能 push、无权限的仓库被拒、未提供凭据和吊销后被拒。`cos-live.test.ts` 对真实 COS 跑这套流程，默认跳过。

## 启动本地服务

先创建 token，再启动服务端。命令行入口是 `yunbox-server`（`packages/server/src/cli.ts`）；在仓库里可以用 `pnpm --filter @yunbox/server start` 运行，构建后也可以直接运行 `node packages/server/dist/cli.mjs`。

```bash
pnpm --filter @yunbox/server start token create --name alice --write demo/assets --storage-dir .yunbox-data
pnpm --filter @yunbox/server start --port 8080 --storage-dir .yunbox-data
```

- 服务默认监听 `http://127.0.0.1:8080`，`--port 0` 可让系统分配临时端口。
- `--host 0.0.0.0 --public-url https://lfs.example.com`：监听其他地址时必须同时给出 https 的 `--public-url`，上传、下载和 verify 地址都基于它生成。服务端不读取任何 `X-Forwarded-*` 头，所以反向代理不需要额外的信任设置；TLS 由反向代理终止。
- 每个请求输出一行 JSON 访问日志（请求 id、方法、不含查询串的路径、状态码、耗时、token id），不包含 token、`Authorization` 头和任何上传或下载地址。

### 管理 token

`token` 子命令只在部署环境或管理员本机执行，`--storage` 和 `--storage-dir` 要和服务端一致：

```bash
# 创建：只在这里输出一次明文 token；服务端只保存它的 SHA-256 哈希
pnpm --filter @yunbox/server start token create --name alice --write 'team/game-assets' --read 'team/*'
# 列出：显示 id、名称、创建时间和权限，不显示哈希
pnpm --filter @yunbox/server start token list
# 吊销：按 id 或名称
pnpm --filter @yunbox/server start token revoke alice
```

- 权限写成 `<owner>/<repo>` 或 `<owner>/*`（在 shell 里要加引号）。`write` 包含 `read`；同一个仓库同时匹配精确条目和通配条目时，以精确条目为准，例如 `--write 'team/*' --read team/locked` 对 `team/locked` 只有读权限。
- 本地存储把 token 存在 `<storage-dir>/_yunbox/tokens.json`（权限 `0600`），COS 存储存在 `<prefix>/_yunbox/tokens.json`。仓库的 owner 必须以字母或数字开头，所以这个位置不会和素材冲突。
- 服务端最多缓存 token 列表 30 秒。上传、下载地址的有效期从授权时所用的 token 列表的读取时间算起，最长 5 分钟，所以**吊销最迟 5 分钟后完全生效**：服务端自己签发的地址每次使用都要重新鉴权，吊销 30 秒内失效；COS 预签名地址无法撤回，只能等它过期。
- token 丢失后无法找回，吊销后重新创建即可。

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

### 用真实 COS 跑端到端测试

```bash
YUNBOX_COS_E2E=1 pnpm exec vitest run packages/server/test/cos-live.test.ts
```

需要上面的环境变量。测试写在 `YUNBOX_COS_PREFIX`（默认 `yunbox-e2e`）下的随机子前缀里，结束后会删除写入的对象。GitHub Actions 里也可以手动触发 `COS E2E` 工作流，它从 `cos-e2e` environment 读取凭据和 bucket 配置。

## 配置测试仓库

在需要使用 LFS 的 Git 仓库中执行（示例仓库路径为 `demo/assets`）：

```bash
git lfs install
git lfs track "*.png" "*.psd" "*.bin"
git config -f .lfsconfig lfs.url http://127.0.0.1:8080/demo/assets
git config lfs.locksverify false
git add .gitattributes .lfsconfig
```

然后把 token 交给 Git 凭据管理器（macOS 的 `osxkeychain`、Git for Windows 的 `manager` 等，`git config --global credential.helper` 可以查看）。最简单的做法是第一次 push 时在提示里输入任意用户名，密码填 token，凭据管理器会记住它。也可以直接写入，`host` 要和 `lfs.url` 的主机和端口一致：

```bash
printf 'protocol=http\nhost=127.0.0.1:8080\nusername=yunbox\npassword=%s\n\n' "$YUNBOX_TOKEN" | git credential approve
```

之后照常 `git add`、`git commit` 和 `git push`。`.lfsconfig` 只应包含服务地址，不能写 token 或其他凭据；也不要把 token 写进 `lfs.url`。token 被吊销后，git-lfs 收到 401 会让凭据管理器删除这条凭据，再次输入新 token 即可。

`lfs.locksverify=false` 是目前唯一允许关闭的检查，因为 Locks API 尚未实现；进入多人编辑二进制素材的试点前必须补齐 Locks API。

## License

[MIT](./LICENSE)

# 云匣 YunBox

> 兼容 Git LFS 的素材托管。代码交给 Git，素材交给云匣。

**状态：M1 协议验证版，仅用于本地开发和自动化测试。**

YunBox 是一个 Git LFS 服务端：代码仍托管在 GitHub 等平台，LFS 大文件存到你自己的对象存储（先支持腾讯云 COS）。协作者只需原版 [git-lfs](https://git-lfs.com) 和仓库里的 `.lfsconfig`，不必安装 YunBox。

- 方案与里程碑：[docs/plan.md](./docs/plan.md)

## 当前能力

- Git LFS Batch API：upload / download，`transfer: basic`
- Verify API：核对对象大小并持久化“已校验”状态
- 仓库隔离的本地文件存储，以及由服务端提供的签名 PUT / GET 地址
- 腾讯云 COS 存储：服务端只签发预签名地址，素材由 git-lfs 直接上传到 COS、从 COS 下载，不经过服务端
- 真实 `git` 和 `git-lfs` 端到端测试

目前还没有鉴权，只使用 HTTP，并且服务端固定监听 `127.0.0.1`（鉴权和公网部署见 [docs/goal.md](./docs/goal.md) 阶段 2、3）。它**不可用于生产或团队共享环境**，也不要通过端口转发将其暴露到其他网络。

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

端到端测试位于 `packages/server/test/`：`e2e.test.ts` 分别用本地存储和一个 COS 测试替身（`packages/core/test/fake-cos-server.ts`，用官方 SDK 重新核对每个签名）跑同一套 git-lfs 流程，不需要任何云端凭据。`cos-live.test.ts` 对真实 COS 跑这套流程，默认跳过。

## 启动本地服务

先构建工作区，再启动服务端：

```bash
pnpm build
pnpm --filter @yunbox/server start --port 8080 --storage-dir .yunbox-data
```

服务只会监听 `http://127.0.0.1:8080`。`--port 0` 可让系统分配临时端口。

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

之后照常 `git add`、`git commit` 和 `git push`。`.lfsconfig` 只应包含服务地址，不能写 token 或其他凭据。

`lfs.locksverify=false` 是 M1 唯一允许关闭的检查，因为 Locks API 尚未实现；进入多人编辑二进制素材的试点前必须补齐 Locks API。

## License

[MIT](./LICENSE)

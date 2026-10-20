# 存储提供方（开发说明）

直连模式下，素材由 `git-yunbox lfs-agent` 用协作者自己的密钥直接上传、下载。存放素材的对象存储叫**提供方**（provider），目前内置两个：

| id | 实现 | 说明 |
|---|---|---|
| `cos` | [`cos.ts`](./cos.ts)、[`../cos/`](../cos/) | 腾讯云 COS，默认；v5 签名，支持全部可选能力 |
| `s3` | [`s3.ts`](./s3.ts)、[`../s3/`](../s3/) | S3 兼容存储（Cloudflare R2、AWS S3、MinIO 等）；SigV4 签名在 `@yunbox/core` 的 `s3-signature.ts`，只实现传输动作 |

用户文档见 [接入 R2 和 S3 兼容存储](../../../../docs/guide/r2.md)，决策记录见 [plan.md](../../../../docs/plan.md) 第 12 节「存储提供方接口」「S3 兼容存储提供方」。

## 不支持第三方插件

提供方只能内置在命令行里，**不会从外部加载任何代码**，以后也不打算开放插件。接口虽然按插件的形状设计，但这只是为了让内置实现彼此隔离、容易测试。原因：

- **插件会经手密钥。** 提供方负责签名，必须拿到用户的 SecretKey / Secret Access Key。第三方插件和云匣运行在同一个进程里，能读到钥匙串里的所有密钥（包括其他提供方的），没有办法只给它看一部分。
- **每次 push / pull 都会运行。** git-lfs 在每次传输时启动传输代理，一个被替换或被投毒的插件会在所有人的每次推送里执行，影响面和 npm 供应链攻击一样大。
- **安全保证在共用代码里，不能被绕过。** 不覆盖已有对象、下载时校验 SHA-256、日志不出现密钥和签名，这些都在共用的 `HttpObjectStore` 里实现；插件如果能自己实现传输，这些保证就只能靠插件作者自觉。
- **审查和分发的成本不值得。** 绝大多数对象存储都兼容 S3，用 `--endpoint` 已经能接；需要特殊签名的服务很少，内置一个提供方的代码量（几百行加测试）比维护插件加载、版本兼容和签名校验小得多。

想接一个新的存储：先试 `git yunbox init --provider s3 --endpoint <地址>`，再用 `yunbox doctor` 检查。确实不兼容 S3 的，欢迎提 issue 或按下面的步骤提交一个内置提供方。

## 接口

定义在 [`provider.ts`](./provider.ts)，分两层：

**传输必需的动作**：`ObjectStore`

| 方法 | 用途 |
|---|---|
| `head(key)` | 对象的大小和 ETag，不存在时返回 `undefined`；上传前跳过已有对象，推送检查也用它 |
| `uploadFile(key, path, { oid, size })` | 不覆盖地上传；已存在且大小一致返回 `skipped` |
| `downloadFile(key, destination, { oid, size })` | 边下载边算 SHA-256，大小或哈希不符就删掉文件并报错 |
| `probe()` | 在 `<前缀>/_yunbox/probe` 依次 PUT、HEAD、GET，`init` 和 `doctor` 用它判断读写权限 |
| `check(key)` | GET 一个键，只返回状态码和服务端错误码；`login` 用它区分「密钥无效」和「没有权限」 |

这些方法**不要自己实现**：所有提供方共用 [`object-store.ts`](./object-store.ts) 里的 `HttpObjectStore`。提供方只实现 `ObjectTransport`：

| 字段 | 含义 |
|---|---|
| `label` | 步骤标题和错误信息里的短名称，例如 `S3` |
| `url(key)` | 对象的完整地址 |
| `sign(request)` | 返回要发送的全部请求头（含签名）。`request.payloadSha256` 是请求体的 SHA-256，上传 LFS 对象时就是 oid |
| `noOverwrite` / `conflictStatuses` | 让 PUT 在对象已存在时失败的请求头，以及表示「已存在」的状态码 |
| `guardUnsupported` | 可选：哪些响应表示服务不支持 `noOverwrite`，这时退回到「先 HEAD 再 PUT」 |
| `hint(status, code)` | 失败时追加的修复提示 |

**可选能力**：`StorageProvider` 上的 `buckets`（列出、新建 bucket）、`policy`（输出访问策略）、`restrictedKeys`（`yunbox subaccount` 建受限密钥）。命令用 `requireCapability` 检查能力，不判断是哪个提供方；没有的能力不用实现，命令会提示去服务自己的控制台操作。

`StorageProvider` 其余的字段负责 `.yunbox/config` 里本提供方配置段的读写和校验（`readConfig`、`writeConfig`、`normalize`、`describe`、`same`）以及密钥（`credentialStores`、`resolveCredentials`、`credentialHelp`）。

## 新增一个内置提供方

1. **签名**：放在 `packages/core/src/<名称>-signature.ts`，手写，不引入云 SDK（运行时零依赖，见 AGENTS.md）。单元测试必须用服务官方公开的签名测试向量或文档示例；能找到官方 SDK 的签名器时，把它加为**开发依赖**，在测试里逐字节核对。
2. **位置**：在 `packages/cli/src/<名称>/location.ts` 定义 `XxxLocation`，带 `provider: '<id>'` 字段，加进 `provider.ts` 的 `StorageLocation` 联合类型、`ProviderId` 和 `PROVIDER_IDS`。配置写在 `.yunbox/config` 的 `[<id>]` 段，并由 `storage.provider = <id>` 选中；校验要拒绝明文 http（本机地址除外）。
3. **传输**：`packages/cli/src/<名称>/client.ts` 实现 `ObjectTransport`，用 `new HttpObjectStore(transport)` 得到 `ObjectStore`。上传要签名内容哈希（或用服务自己的完整性校验），不覆盖语义要查官方文档确认，结论和链接写进 plan.md 第 12 节，查不到的标「未核实」。
4. **密钥**：用 `defaultSecretStores(env, undefined, '<id>')`，钥匙串项和兜底文件按提供方分开；环境变量用 `YUNBOX_<ID>_*`，不要读通用变量（例如 `AWS_*`），避免把用户在别处的身份发给这个服务。
5. **注册**：在 `storage/<名称>.ts` 导出 provider 对象（`satisfies StorageProvider<XxxLocation>`），在 `storage/config.ts` 的 `providerById` 和 `readStorageLocation` / `writeStorageLocation` 里加上它；在 `commands/init-cos.ts` 加选择位置的交互，在 `commands/login.ts` 加密钥格式校验和提示文字。
6. **兼容**：`doctor --json` 的 `mode` 保持 `cos`（macOS 客户端按枚举严格解码），用 `provider` 字段区分；COS 的配置继续不写 `storage.provider`，让旧版命令行能读。
7. **测试**：
   - 测试替身放在 `packages/core/test/`，用独立的实现（官方 SDK 或签名器）重新核对每个签名，并能注入「不支持不覆盖」「只读密钥」「内容被篡改」等情况；
   - `packages/cli/test/` 里用真实的 git 和 git-lfs 跑完整流程：推送、全新 clone、SHA-256 一致、重复推送不重复上传、日志里没有密钥和签名；
   - 对真实服务的测试默认跳过，需要环境变量才运行（参考 `s3-live.test.ts`）。
8. **文档**：`docs/guide/` 下写接入指南（权限怎么限定到最小、有哪些服务端限制），两份更新日志的「未发布」各加一条，plan.md 第 12 节记录结论和新风险。

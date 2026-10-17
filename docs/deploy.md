# 部署到 CloudBase 云托管

> 适用范围：G1 阶段 3（见 [goal.md](./goal.md)）。日期：2026-10-17
> 本文还没有在真实的 CloudBase 环境里走过一遍。标「**未核实**」的内容来自记忆或推断，没有在官方文档里找到原文，部署时要在控制台逐项确认，确认后把结论更新到本文和 [plan.md](./plan.md) 第 12 节。

## 架构

```text
git-lfs ──HTTPS──▶ CloudBase 入口（TLS 终止，自定义域名）──HTTP──▶ 容器 yunbox-server（0.0.0.0:8080）
   │                                                                  │
   └────────── HTTPS 预签名 PUT / GET（素材直传，不经过服务端）──────▶ COS 私有 bucket ◀── HEAD / 标记对象 / token 文档
```

- 服务端只处理 batch、verify 和健康检查，素材由 git-lfs 直接上传到 COS、从 COS 下载。
- TLS 在 CloudBase 入口终止，容器内只有 HTTP。所有上传、下载和 verify 地址都基于 `YUNBOX_PUBLIC_URL` 生成，服务端不读取任何 `X-Forwarded-*` 头。
- token 文档存在 `<prefix>/_yunbox/tokens.json`，只保存 token 的 SHA-256 哈希。

## 已查证的平台约定

查询日期 2026-10-17：

| 项目 | 结论 | 来源 |
|---|---|---|
| 监听端口 | 部署时填写服务监听的端口；容器内的 `PORT` 环境变量始终等于请求发到的端口，官方建议代码优先监听它 | [开发指南](https://docs.cloudbase.net/run/develop/developing-guide) |
| 默认端口 | 旧版「云托管 CloudBase Run」版本配置的监听端口默认 80 | [版本配置说明](https://cloud.tencent.com/document/product/1243/49177) |
| 健康检查 | 有 `InitialDelaySeconds`（默认 2 秒），失败重试 3 次后判定版本异常；**探测方式（TCP 还是 HTTP）和路径文档里没有写** | 同上 |
| 环境变量 | 可以按键值对或 JSON 设置，容器内可读取 | [服务配置](https://docs.cloudbase.net/run/deploy/service-setting) |
| 公网访问 | 默认开启并提供默认域名，可在「服务详情 → 服务设置」关闭；默认不做鉴权；默认域名只建议开发测试用，正式使用建议自定义域名 | [公网访问](https://docs.cloudbase.net/run/deploy/networking/public)、[自定义域名](https://docs.cloudbase.net/run/deploy/networking/custom-domains) |
| 自定义域名 | 需要 SSL 证书；路由的「鉴权」和「路径透传」默认关闭 | [自定义域名](https://docs.cloudbase.net/run/deploy/networking/custom-domains) |

**未核实**：服务绑定运行角色后，平台是否把临时密钥注入为 `TENCENTCLOUD_SECRETID`、`TENCENTCLOUD_SECRETKEY`、`TENCENTCLOUD_SESSIONTOKEN` 环境变量。云函数（SCF）是这样做的，云托管的文档里没有找到。没有注入时的做法见[运行角色与密钥](#4-运行角色与密钥)。

## 镜像

仓库根目录的 [Dockerfile](../Dockerfile) 是多阶段构建：

- 构建阶段按 `package.json#packageManager` 安装 pnpm，用锁文件安装依赖、构建 `@yunbox/core` 和 `@yunbox/server`，再用 `pnpm deploy --prod` 生成只含生产依赖的目录（目前只有构建产物和 `@yunbox/core`，没有第三方运行时依赖）。
- 基础镜像固定为 `node:24.22.0-bookworm-slim` 的摘要（多架构，含 amd64 和 arm64），只用 Node.js LTS 版本，和 `.node-version`、CI 保持一致。Dependabot 每周检查同一大版本内的更新，不会提出跨大版本的升级；新的大版本进入 LTS 后（Node 26 是 2026-10-28），再手动同时修改 Dockerfile 和 `.node-version`。
- 运行阶段以内置的非 root 用户 `node` 运行，应用文件归 root 所有、服务用户不能修改。
- 默认环境变量：`YUNBOX_HOST=0.0.0.0`、`YUNBOX_STORAGE=cos`、`YUNBOX_STORAGE_DIR=/data`（只在本地测试用 `local` 存储时使用）。
- 入口是 `node /app/dist/cli.mjs`，默认参数 `serve`，所以 `docker run <镜像> token list` 可以直接运行管理命令。
- Docker `HEALTHCHECK` 请求 `GET /_health`。CloudBase 是否使用镜像里的 `HEALTHCHECK` **未核实**，以控制台的健康检查配置为准。

本地构建和冒烟测试（不需要云账号）：

```bash
docker build -t yunbox-server:dev .
docker volume create yunbox-data
docker run --rm -v yunbox-data:/data -e YUNBOX_STORAGE=local yunbox-server:dev \
  token create --name smoke --write demo/assets
docker run --rm -p 127.0.0.1:8080:8080 -v yunbox-data:/data \
  -e YUNBOX_STORAGE=local -e YUNBOX_PUBLIC_URL=https://lfs.example.test yunbox-server:dev
curl -s http://127.0.0.1:8080/_health
```

本地测试时 `YUNBOX_PUBLIC_URL` 可以随便填一个 https 地址，只是 batch 返回的地址会指向它；要用 git-lfs 完整走一遍，改为在本机直接运行服务端（见 [README](../README.md)）。

## 配置

所有配置都来自环境变量，命令行参数优先于环境变量。服务启动前先做配置自检：缺少或格式不对的项**一次全部列出**，然后以状态码 1 退出。错误信息只写配置项和环境变量的名字，不会出现任何值。

| 环境变量 | 命令行参数 | 说明 |
|---|---|---|
| `YUNBOX_HOST` | `--host` | 监听地址。镜像默认 `0.0.0.0`，不在镜像里时默认 `127.0.0.1` |
| `YUNBOX_PORT`，其次 `PORT` | `--port` | 监听端口，默认 8080。CloudBase 会设置 `PORT`，所以一般不用设置 `YUNBOX_PORT` |
| `YUNBOX_PUBLIC_URL` | `--public-url` | 客户端访问的 https origin，例如 `https://lfs.example.com`，不能带路径。监听在非回环地址时必填 |
| `YUNBOX_STORAGE` | `--storage` | `cos` 或 `local`。镜像默认 `cos` |
| `YUNBOX_STORAGE_DIR` | `--storage-dir` | `local` 存储的目录 |
| `YUNBOX_COS_BUCKET` | — | 必填，格式 `<名称>-<APPID>` |
| `YUNBOX_COS_REGION` | — | 必填，例如 `ap-guangzhou` |
| `YUNBOX_COS_PREFIX` | — | 强烈建议设置，例如 `yunbox`。CAM 权限按这个前缀授予 |
| `TENCENTCLOUD_SECRETID`、`TENCENTCLOUD_SECRETKEY` | — | 必填，最好由运行角色注入（见下文） |
| `TENCENTCLOUD_SESSIONTOKEN` | — | 使用临时密钥时必填 |

启动日志会说明正在使用临时密钥还是长期密钥（只看 `TENCENTCLOUD_SESSIONTOKEN` 是否存在，不输出任何密钥）。看到 `long-term credentials` 说明没有用上运行角色。

`.lfsconfig` 只写 `lfs.url`，例如 `https://lfs.example.com/team/game-assets`，永远不写 token。

## 部署步骤

### 1. 准备 COS bucket

1. 在与云托管同一地域创建 bucket，**访问权限选私有读写**。不要配置公有读、不要开启静态网站。
2. 确定键前缀，例如 `yunbox`。对象键是 `<prefix>/<owner>/<repo>/<oid[0:2]>/<oid[2:4]>/<oid>`，token 文档是 `<prefix>/_yunbox/tokens.json`。
3. 不要给 bucket 配置生命周期规则删除 `<prefix>/` 下的对象：已校验标记和 token 文档都在这里。
4. 真实 COS 端到端测试另用一个前缀（例如 `yunbox-e2e`），最好用另一个 bucket，见[手动运行 COS E2E](#手动运行-cos-e2e)。

### 2. 费用告警

在腾讯云「费用中心」为 COS 和云开发设置预算或余额告警（入口和名称**未核实**）。主要成本是 COS 外网下行流量（每次 clone、checkout 都会从 COS 下载素材）、存储量和请求次数；云托管按实例规格和运行时长计费。建议：

- 设置每月预算告警，阈值按试点预期流量的 2 倍左右设置。
- 在 COS 控制台查看监控，试点第一周每天看一次下行流量。

### 3. CAM 最小权限

服务端只需要对 `<prefix>/` 下的对象执行 `PutObject`、`GetObject`、`HeadObject`、`DeleteObject`（删除只用于已校验标记）。其中 `PutObject` / `GetObject` 也用于读写 token 文档。策略示例（资源格式凭记忆写成，**未核实**，创建时用控制台的策略生成器核对）：

```json
{
  "version": "2.0",
  "statement": [
    {
      "effect": "allow",
      "action": [
        "name/cos:PutObject",
        "name/cos:GetObject",
        "name/cos:HeadObject",
        "name/cos:DeleteObject"
      ],
      "resource": [
        "qcs::cos:ap-guangzhou:uid/1250000000:examplebucket-1250000000/yunbox/*"
      ]
    }
  ]
}
```

- 把地域、APPID、bucket 和前缀换成自己的。不要授予 `GetBucket`（列出对象）、`PutBucketACL`、`PutObjectACL` 或 `cos:*`。
- 预签名地址用服务端当时的密钥签名，所以 git-lfs 直传的权限也受这个策略限制。

### 4. 运行角色与密钥

推荐：创建一个 CAM 角色，挂上第 3 步的策略，在云托管服务上绑定这个角色，由平台注入临时密钥。角色的载体（信任的服务主体）应该填哪个服务、在控制台哪里绑定，都**未核实**。

部署后看启动日志：

- 出现 `using temporary credentials` 说明平台注入了 `TENCENTCLOUD_SESSIONTOKEN`，运行角色生效。
- 如果启动失败并提示 `TENCENTCLOUD_SECRETID must be set to use COS storage`，说明平台没有用这几个环境变量注入密钥。这时**先不要上线**，把情况记到 plan.md 第 12 节再决定：要么在服务端增加从平台元数据接口获取临时密钥的代码，要么临时改用一个只挂第 3 步策略的子账号密钥，作为环境变量配置在云托管（启动日志会显示 `long-term credentials`，要定期轮换）。

服务端每次签名前都会重新读取这几个环境变量；平台是否会在不重启容器的情况下更新环境变量里的临时密钥**未核实**，见 plan.md 第 12 节的风险。

### 5. 创建云托管服务

控制台字段名凭记忆写成，**未核实**：

1. 在已有的云乐坊 CloudBase 环境里新建云托管服务，例如 `yunbox`。
2. 部署方式选代码仓库（或本地上传代码 / 镜像），构建目录是仓库根目录，Dockerfile 名为 `Dockerfile`。
3. **监听端口填 8080**。平台会把这个端口通过 `PORT` 传给容器，服务端会监听它。
4. 环境变量按上一节的表填写：`YUNBOX_PUBLIC_URL`、`YUNBOX_COS_BUCKET`、`YUNBOX_COS_REGION`、`YUNBOX_COS_PREFIX`。不要在这里填长期密钥，除非走第 4 步的临时方案。
5. 健康检查：如果可以配置 HTTP 探测，路径填 `/_health`；如果只能 TCP 探测，用默认即可。`InitialDelaySeconds` 设为 10 秒左右：服务端启动时会先从 COS 读一次 token 文档，读不到就退出。
6. 实例规格：0.5 核 / 1 GB 足够（服务端不经手素材内容）。最小实例数建议设为 1，避免冷启动让 git-lfs 的第一次请求超时；多实例时每个实例各自缓存 token 30 秒，吊销时限不变。
7. 绑定第 4 步的运行角色。

`/_health` 不需要鉴权，只返回 `{"status":"ok"}`，不读存储、不读 token、不暴露任何配置；成功的探测不写访问日志。

### 6. 域名、TLS 和公网访问

1. 绑定自定义域名（例如 `lfs.example.com`）并上传或申请 SSL 证书，TLS 在 CloudBase 入口终止。
2. 路由路径用 `/`，把整个域名交给 YunBox；`YUNBOX_PUBLIC_URL` 只能是 origin，不能带路径。如果一定要挂在子路径下，需要开启「路径透传」并修改服务端，目前不支持。
3. 路由的「鉴权」保持关闭：git-lfs 用 HTTP Basic 认证，由 YunBox 自己校验 token。CloudBase 的网关鉴权是否会占用 `Authorization` 头**未核实**，开启后很可能让 git-lfs 无法认证。
4. 默认域名只用于部署后的检查，不要写进 `.lfsconfig`。检查通过后可以考虑在服务设置里关闭默认域名的公网访问（是否能只关默认域名、保留自定义域名**未核实**）。

**确认 HTTP 不会把凭据送到公网**：Basic 认证的内容是明文，必须确认客户端不能用明文 HTTP 访问服务：

```bash
# 期望：301/302/307/308 跳转到 https，或连接被拒绝；不应返回 200
curl -sS -o /dev/null -w '%{http_code} %{redirect_url}\n' http://lfs.example.com/_health
# 期望：200 {"status":"ok"}
curl -sS https://lfs.example.com/_health
# 期望：401，并带 LFS-Authenticate 头（没有凭据）
curl -sS -i -X POST https://lfs.example.com/demo/assets/objects/batch \
  -H 'Content-Type: application/vnd.git-lfs+json' -d '{"operation":"download","objects":[]}'
```

- 如果 `http://` 返回 200，查找自定义域名的「强制 HTTPS」或跳转设置（是否存在**未核实**）。在找到之前，务必让所有人的 `lfs.url` 都以 `https://` 开头；服务端看不到原始协议，无法自己拒绝明文请求。注意 git-lfs 收到跳转后，是否在 https 上重发凭据也要实测。
- 容器端口不应该有公网 IP 能直接访问（云托管不给容器分配公网 IP，**未核实**）；VPC 内网访问是 HTTP，只在内网使用。

### 7. 创建 token 并接入仓库

token 管理用同一个镜像或仓库里的 `yunbox-server token`，存储参数要和服务端一致。推荐在管理员本机执行，用一个只授予 `<prefix>/_yunbox/tokens.json` 读写权限的子账号密钥（`GetObject`、`PutObject`），不要用服务端的运行角色：

```bash
export YUNBOX_STORAGE=cos
export YUNBOX_COS_BUCKET=examplebucket-1250000000
export YUNBOX_COS_REGION=ap-guangzhou
export YUNBOX_COS_PREFIX=yunbox
export TENCENTCLOUD_SECRETID=...     # 管理员子账号，只在当前 shell 里设置，不要写进文件
export TENCENTCLOUD_SECRETKEY=...

docker run --rm -e YUNBOX_STORAGE -e YUNBOX_COS_BUCKET -e YUNBOX_COS_REGION -e YUNBOX_COS_PREFIX \
  -e TENCENTCLOUD_SECRETID -e TENCENTCLOUD_SECRETKEY \
  yunbox-server:dev token create --name alice --write 'team/game-assets'
# 或者在仓库里：pnpm --filter @yunbox/server start token create --name alice --write 'team/game-assets'
```

- `create` 只输出一次明文 token，通过私聊等安全渠道交给本人；`list` 只显示 id、名称、时间和权限；`revoke <id 或名称>` 吊销后最迟 5 分钟完全生效（服务端缓存 30 秒，COS 预签名地址最长 5 分钟有效）。
- token 文档没有并发保护，**同一时间只能有一个人管理 token**。
- 成员接入：`.lfsconfig` 写 `lfs.url=https://lfs.example.com/<owner>/<repo>`，`git config lfs.locksverify false`，第一次 push 时用户名随意、密码填 token，详见 [README](../README.md#配置测试仓库)。

### 8. 上线检查清单

- [ ] bucket 私有读写，CAM 策略只含 4 个动作、资源限定在 `<prefix>/*`
- [ ] 启动日志显示 `temporary credentials`（或已记录改用子账号密钥的原因和轮换计划）
- [ ] `YUNBOX_PUBLIC_URL` 是 https 自定义域名，`http://` 不返回 200
- [ ] `https://<域名>/_health` 返回 200，未带凭据的 batch 返回 401
- [ ] 路由鉴权关闭，路径为 `/`
- [ ] 费用告警已设置
- [ ] 在测试仓库里 push、全新目录 clone、checkout 旧版本，SHA-256 一致
- [ ] 已在真实 COS 上运行一次 `COS E2E` 工作流并通过

## 手动运行 COS E2E

`COS E2E` 工作流（[.github/workflows/cos-e2e.yml](../.github/workflows/cos-e2e.yml)）用真实 `git`、`git-lfs` 在真实 COS 上跑 M1 的全部场景，只能手动触发，普通 CI 不需要任何云端凭据。

1. 在 GitHub 仓库的 Settings → Environments 新建 `cos-e2e`，建议加上「Required reviewers」。
2. 新建一个测试专用子账号，CAM 策略同第 3 步，但资源限定在测试前缀（例如 `.../yunbox-e2e/*`）。
3. 在 `cos-e2e` environment 里配置：
   - Secrets：`TENCENTCLOUD_SECRETID`、`TENCENTCLOUD_SECRETKEY`（测试子账号）
   - Variables：`YUNBOX_COS_BUCKET`、`YUNBOX_COS_REGION`，可选 `YUNBOX_COS_PREFIX`（默认 `yunbox-e2e`）
4. 在 Actions 页面选择 `COS E2E` → Run workflow，或者：

   ```bash
   gh workflow run cos-e2e.yml --ref main
   gh run watch
   ```

5. 测试在 `<prefix>/` 下的随机子前缀里写入对象和 `_yunbox/tokens.json`，结束后删除。失败时到 COS 控制台检查有没有残留。
6. 通过后把日期、git-lfs 版本和发现的问题记到 plan.md 第 12 节。

本机也可以运行同一个测试（需要上面的环境变量）：

```bash
YUNBOX_COS_E2E=1 pnpm exec vitest run packages/server/test/cos-live.test.ts
```

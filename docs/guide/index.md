# 快速开始

云匣让 git-lfs 把素材直接存进你自己的腾讯云 COS（也支持 Cloudflare R2 等 S3 兼容存储）：代码仍在 GitHub 等平台，PSD、模型、音频、视频这些大文件由每个人电脑上的传输代理签名后直传 COS，**中间没有服务端**。

```
git push / clone ──▶ git-lfs ──▶ git-yunbox lfs-agent ──▶ 腾讯云 COS
```

传输代理用本机保存的密钥签名，直接上传、下载 COS。

想用 Cloudflare R2（下载流量免费）、AWS S3 或 MinIO？见[接入 R2 和 S3 兼容存储](./r2)。

## 安装

```bash
npm install -g yunbox
```

需要 Node.js 22.18+、Git 2.30+ 和 git-lfs 3.2+。安装后同时得到 `yunbox` 和 `git-yunbox` 两个命令，`git yunbox <命令>` 和 `yunbox <命令>` 完全一样。

想用图形界面查看推送体积和直连状态，可以再装 [macOS 客户端](./macos)。

::: tip 为什么每个人都要装命令行
git-lfs 出于安全考虑，不允许仓库通过 `.lfsconfig` 指定传输程序，所以传输代理只能由 `git yunbox init` 写进各自 clone 的 `.git/config`。
:::

## 管理员：给仓库接上 COS

第一次接入只需要做一次，用管理员身份。仓库已经在用 GitHub LFS 等服务存素材的，按[从 GitHub LFS 迁移](./migrate)操作：

```bash
tccli auth login             # 浏览器登录腾讯云，临时密钥约 2 小时有效
git yunbox init              # 选一个 bucket 或新建私有 bucket，填目录前缀，自动做读写探测
git add .gitattributes .yunbox/config
git commit -m "chore: 用 YunBox 把 LFS 素材直传到 COS"
git push
```

`git yunbox init` 会按素材类型生成 `.gitattributes`（贴图、设计源文件、模型、音频、视频、字体、压缩包），把 bucket、地域和前缀写进 `.yunbox/config`。这个文件提交到仓库供全组共享，**不含任何密钥**。

以后想看哪些类型已经走 LFS、增减类型，用 `git yunbox types`：

```bash
git yunbox types                 # 每个类型是否走 LFS、有多少文件，以及作为普通文件提交的素材
git yunbox types add model,audio # 也可以写预置组合：game、design、media、all
git yunbox types remove video    # 只删 YunBox 生成的规则，手写的不动
```

然后给自己换一把长期密钥，不用每两小时重新登录：

```bash
yunbox subaccount create --save   # 新建只能读写这个前缀的子账号，密钥存进本机钥匙串
```

## 给协作者开子账号

同样在管理员登录状态下：

```bash
yunbox subaccount create yunbox-alice --show-key              # 新建并显示一次密钥，通过安全渠道转交
yunbox subaccount create yunbox-bob --show-key --read-only    # 只需要拉取的人
yunbox subaccount list                                        # 查看 YunBox 建的子账号和各自的前缀
yunbox subaccount delete yunbox-alice                         # 有人离开：删除子账号，密钥立即失效
```

子账号只能编程访问，策略只授权这个前缀下对象的 `PutObject`、`GetObject`、`HeadObject`（只读去掉 `PutObject`）：不能列出 bucket、不能删除，也碰不到其他前缀。

协作者拿到密钥后，按[协作者加入](./collaborators)操作。

## 出问题时

```bash
yunbox doctor
```

逐项检查 git、git-lfs、传输代理、密钥和读写权限，没通过的项都附修复命令。加 `--json` 可以给其他工具读取。

## 已知限制

- 没有服务端就没有文件锁，`lfs.locksverify` 设为 `false`。同一个素材同一时间请只由一个人编辑。
- 需要集中签发、吊销 token 的团队，可以改用[服务端模式](../deploy)。

完整的命令说明见仓库 [README](../../README.md)。

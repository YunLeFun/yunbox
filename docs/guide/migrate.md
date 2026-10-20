# 从 GitHub LFS 迁移

仓库已经在用 GitHub LFS（或 GitLab、Gitea、自建 LFS 服务、云匣服务端模式）存素材，想改成直连自己的 COS：把全部历史素材从旧服务下载到本地，切换传输代理，再整体上传到 COS。代码历史不用改写，提交号保持不变。

整个过程由一位管理员在一份全新的 clone 里完成，其他人之后各自切换。

```
旧 LFS 服务 ──git lfs fetch --all──▶ 本地 .git/lfs ──git lfs push --all──▶ 腾讯云 COS
```

## 迁移前准备

1. **安装命令行**：`npm install -g yunbox`，需要 Node.js 22.18+、Git 2.30+ 和 git-lfs 3.2+（见[快速开始](./#安装)）。
2. **准备 bucket 和密钥**：管理员用 `tccli auth login` 登录，迁移时由 `git yunbox init` 选择或新建私有 bucket；之后可以用 `yunbox subaccount create --save` 换成长期子账号密钥。已经有子账号密钥的，用 `yunbox login` 保存。子账号不能列出 bucket，运行 `git yunbox init` 时要加上 `--bucket`、`--region`、`--prefix`。
3. **给协作者开子账号**：`yunbox subaccount create <名称> --show-key`，只需要拉取的人加 `--read-only`（见[给协作者开子账号](./#给协作者开子账号)）。
4. **估算空间和时间**：迁移要把全部历史素材下载到本地再上传一遍。先看一下总量：

   ```bash
   git lfs ls-files --all --size
   ```

   本地磁盘要放得下这些对象，COS 也会按同样的体积计费。
5. **通知团队**：请大家在切换前推送完手头的素材，切换完成、自己也接好云匣之前不要再推送素材（原因见[其他协作者怎么切换](#其他协作者怎么切换)）。

## 1. 拉下全部历史对象

在一份**全新的 clone** 里操作，旧服务的所有分支和标签都会作为远程分支和标签带下来：

```bash
git clone <仓库地址> migrate-assets
cd migrate-assets
git lfs fetch --all
```

`git lfs fetch --all` 从旧服务下载所有分支、标签历史中引用过的 LFS 对象，存进 `.git/lfs/objects`。旧服务的远程不叫 `origin` 时，写成 `git lfs fetch --all <远程名>`。

::: warning 一定要在 init 之前
`git yunbox init` 之后，这份 clone 的 git-lfs 就只从 COS 下载了，而 COS 里还什么都没有。忘了这一步的话，先按[回滚](#回滚)的方法去掉传输代理，`git lfs fetch --all` 之后再重新运行 `git yunbox init`。
:::

## 2. 切换到直连 COS

```bash
git yunbox init                       # 管理员登录：选择或新建 bucket，填目录前缀
git yunbox init --bucket <名称-APPID> --region <地域> --prefix <前缀>   # 子账号密钥：直接指定
```

前缀默认是 `yunbox/<owner>/<repo>`（取自 `origin` 的地址）。`git yunbox init` 会先用本机密钥在这个前缀做一次读写探测，通过后才修改仓库：写入 `.yunbox/config`，在这份 clone 的 `.git/config` 里登记传输代理（`lfs.standalonetransferagent=yunbox`），并设置 `lfs.locksverify=false`。

### 检查 .gitattributes

`git yunbox init` 会把云匣的素材规则（贴图、设计源文件、模型、音频、视频、字体、压缩包）合并进已有的 `.gitattributes`，原有规则保持不变。先看一下：

```bash
git status
git diff .gitattributes
```

如果除了 `.gitattributes` 还有别的文件显示为已修改，说明新规则匹配到了之前作为普通文件提交的文件（例如以前没有用 LFS 管理的 `.zip`）。把这样的规则提交上去，这些文件在历史里仍是普通文件，`git lfs fsck` 会报错。迁移只换存储位置、不改规则时，直接丢掉新增的规则：

```bash
git checkout -- .gitattributes
```

只想追加部分素材类型，可以重新运行 `git yunbox init --types model,audio` 之类，只加这几类。要把历史里的普通文件也改成 LFS，需要 `git lfs migrate import` 改写历史，不在本文范围内。

### 旧服务写在 .lfsconfig 里的情况

GitLab、Gitea、自建服务或云匣服务端模式，通常在 `.lfsconfig` 里写了 `lfs.url`。`git yunbox init` 会提示：

```text
! lfs.url：.lfsconfig 里还有服务端模式的 lfs.url（…）；直连 COS 时不会用到它
```

已经接好云匣的 clone 不会再用到它，先**保留**：还没切换的协作者照常连旧服务，回滚时也不用再改回来。等旧服务停用时再删（见[旧 LFS 服务什么时候可以停用](#旧-lfs-服务什么时候可以停用)）。GitHub LFS 没有 `lfs.url`，地址由 git-lfs 从 `origin` 推出来，这一节可以跳过。

## 3. 上传全部历史

```bash
git lfs push --all origin $(git for-each-ref --format='%(refname)' refs/heads refs/remotes/origin refs/tags)
```

在 macOS、Linux 终端或 Git Bash 里运行。`git lfs push` 要写远程名（这里是 `origin`），但传输代理不连远程地址，对象直接上传到 `.yunbox/config` 指定的 COS 位置。

::: warning 要把分支和标签列出来
只写 `git lfs push --all origin` 时，git-lfs 只看本地分支和标签。全新 clone 里只有默认分支是本地分支，其他分支只存在于 `refs/remotes/origin/`，它们独有的素材会被漏掉。上面的命令把本地分支、远程分支和标签都列了出来。
:::

传输代理上传前会先查 COS 里有没有这个对象，已有的直接跳过，所以这条命令可以放心地重复运行。

## 4. 提交并推送

所有历史素材都在 COS 里之后，再提交配置：

```bash
git add .gitattributes .yunbox/config
git commit -m "chore: 用 YunBox 把 LFS 素材直传到 COS"
git push
```

顺序不要反过来：先推送这次提交、后上传历史的话，最先切换的协作者会遇到 COS 里还没有的旧素材。

## 5. 验证

在迁移用的 clone 里：

```bash
yunbox doctor
```

全部通过后，**换一个全新目录**按协作者的方式 clone，把全部历史从 COS 下载一遍：

```bash
cd ..
git yunbox clone <仓库地址> verify-assets
cd verify-assets
git lfs fetch --all
git lfs fsck
```

`git lfs fetch --all` 不报错，说明每个分支、标签引用的对象都能从 COS 下载，并且大小和 SHA-256 都核对过；`git lfs fsck` 输出 `Git LFS fsck OK` 说明当前版本的指针和对象一致。可以再 `git checkout` 几个旧标签或分支，打开素材看看。

## 其他协作者怎么切换

切换只对做过 `git yunbox init` 的 clone 生效。拉到迁移提交但还没 init 的 clone，git-lfs **仍然连旧服务**，推送的素材也会进旧服务，COS 里没有。所以请每个人尽快切换：

```bash
yunbox login          # 保存管理员给的子账号密钥
git pull
git yunbox init && git lfs pull
yunbox doctor         # 只读权限用 yunbox doctor --read-only
```

还没 init 的 clone 运行 `yunbox doctor`，会在「传输代理」一项报错并提示 `git yunbox init`。

切换前已经往旧服务推送过新素材的人，init 之后在自己的 clone 里补传一次（这些对象只在对方本地）：

```bash
git lfs push --all origin $(git for-each-ref --format='%(refname)' refs/heads refs/remotes/origin refs/tags)
```

新加入的人直接 `git yunbox clone <仓库地址>`，见[协作者加入](./collaborators)。

CI 里用旧服务拉素材的流水线（例如 `actions/checkout` 的 `lfs: true`）也要改：安装 YunBox 命令行，用只读子账号的密钥设置 `TENCENTCLOUD_SECRETID`、`TENCENTCLOUD_SECRETKEY` 环境变量，然后 `git yunbox init --read-only && git lfs pull`。

## 回滚

旧服务里的对象在迁移中不会被删除，只要它还在，随时可以回去。

**单份 clone 换回旧服务**：去掉传输代理，git-lfs 就恢复到原来的 LFS 地址：

```bash
git config --local --unset lfs.standalonetransferagent
git config --local --remove-section lfs.customtransfer.yunbox
git config --local --unset lfs.locksverify   # 可选：旧服务支持文件锁时恢复锁检查
```

**整个仓库撤销迁移**：切换后新推送的素材只在 COS 里，要先送回旧服务。在一份已接好云匣的 clone 里：

```bash
git lfs fetch --all                              # 先从 COS 下载全部对象
git config --local --unset lfs.standalonetransferagent
git config --local --remove-section lfs.customtransfer.yunbox
git lfs push --all origin $(git for-each-ref --format='%(refname)' refs/heads refs/remotes/origin refs/tags)
git rm -r .yunbox
git commit -m "chore: 素材改回原来的 LFS 服务"
git push
```

然后请每位协作者在自己的 clone 里执行上面「单份 clone」的两条命令。仓库里没有 `.yunbox/config` 后，还留着传输代理的 clone 推送和拉取都会报「仓库里没有 .yunbox/config」，正好提醒他们处理。COS 里的对象不会自动删除，子账号也没有删除权限，需要时由管理员在 COS 控制台清理这个前缀。

## 常见问题

### 大仓库要多久？

主要花在下载和上传两遍全部历史上，耗时大致是「总体积 ÷ 下行带宽 + 总体积 ÷ 到 COS 的上行带宽」。建议在网络好、磁盘够的机器上跑，最好选和 bucket 同地域的云服务器。git-lfs 默认同时传 8 个对象，素材数量多、单个文件小时可以调高：

```bash
git config lfs.concurrenttransfers 16
```

### 中途断了怎么办？

两步都可以直接重跑。`git lfs fetch --all` 会跳过本地已有的对象；`git lfs push --all` 时传输代理先查 COS，已经上传的对象直接跳过，不会重复上传，也不会覆盖。git-lfs 的进度条仍会把跳过的对象算进去，看起来像全部重新传了一遍，这是正常的。单个对象上传到一半断开时，COS 里不会留下残缺的对象，重跑时会重新上传它。

### 有的对象在旧服务里已经找不到了

`git lfs fetch --all` 下载这些对象时会报错；之后 `git lfs push --all` 会把本地缺失的对象列成 `(missing) 文件名 (oid)` 并以失败退出，其余对象照常上传。先看看能不能从别人的 clone 找回：在对方的 clone 里接好云匣，再运行上面的 `git lfs push --all` 命令补传。确实找不回时，可以让 git-lfs 跳过缺失的对象：

```bash
git config lfs.allowincompletepush true
git lfs push --all origin $(git for-each-ref --format='%(refname)' refs/heads refs/remotes/origin refs/tags)
git config --unset lfs.allowincompletepush
```

这些对象对应的旧版本以后无法恢复。

### 旧 LFS 服务什么时候可以停用？

满足下面几条之后：

- 在全新目录里 `git yunbox clone` 加 `git lfs fetch --all` 验证通过；
- 所有协作者和 CI 都已切换（各自 `yunbox doctor` 通过），确认没有人再往旧服务推送；
- 观察一段时间（例如一两周），不再需要[回滚](#回滚)。

停用后，把 `.lfsconfig` 里旧服务的地址删掉并提交（GitHub LFS 没有这一步）：

```bash
git config --file .lfsconfig --unset lfs.url
git add .lfsconfig            # .lfsconfig 变空时改用 git rm .lfsconfig
git commit -m "chore: 删除旧 LFS 服务地址"
```

GitHub LFS 的存储和流量按 GitHub 的规则计费，清理已有对象的方式以 GitHub 文档为准。迁移后新推送的素材不在 GitHub LFS 里，GitHub 网页上看不到它们的内容。

::: tip 本文怎么验证的
上面的流程在本地实际跑过（git 2.55、git-lfs 3.7.1）：旧服务分别用本地裸仓库自带的 LFS 存储和云匣服务端模式（`.lfsconfig` 里写 `lfs.url`）代替，COS 用仓库测试用的 COS 替身，验证了多分支、标签、重复上传不重复写入、缺失对象、协作者补传和回滚。没有对真实的 GitHub LFS 和真实 COS 跑过；遇到和本文不一致的地方，欢迎[提 issue](https://github.com/YunLeFun/yunbox/issues)。
:::

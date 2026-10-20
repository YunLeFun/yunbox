# 协作者加入

管理员已经给仓库接好了 COS，并给了你一组子账号密钥（SecretId 和 SecretKey）。

仓库用的是 Cloudflare R2 或其他 S3 兼容存储时，你拿到的是访问密钥 ID 和机密访问密钥，请按[接入 R2 和 S3 兼容存储](./r2#协作者加入)操作。

## 1. 安装命令行

```bash
npm install -g yunbox
```

需要 Node.js 22.18+、Git 2.30+ 和 git-lfs 3.2+。Windows 上使用 Git for Windows 自带的 git-lfs。

## 2. 保存密钥

```bash
yunbox login
```

SecretKey 输入时不显示，也不接受命令行参数，不会留在 shell 历史里。

- macOS 上存进登录钥匙串的「yunbox」项。
- Linux 和 Windows 上存在 `~/.config/yunbox/credentials.json`（Windows 为 `%APPDATA%\yunbox`），只有本人可读。

不再需要时运行 `yunbox logout`，钥匙串和文件里的副本都会删除。

## 3. clone 仓库

```bash
git yunbox clone <仓库地址>
```

等于 clone 代码历史、运行 `git yunbox init` 接上传输代理、再 `git lfs pull` 下载素材。

已经 clone 过的仓库，在仓库目录里运行：

```bash
git yunbox init && git lfs pull
```

## 4. 照常使用

之后就是普通的 `git add`、`git commit`、`git push`、`git pull`。素材由 git-lfs 交给云匣的传输代理，直接上传到 COS 或从 COS 下载；下载时会核对大小和 SHA-256，损坏的对象不会写进你的工作区。

推送不上去或者拉不下来，先运行：

```bash
yunbox doctor
```

只有只读权限的同学用 `yunbox doctor --read-only`。

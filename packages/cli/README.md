# yunbox

云匣 YunBox 命令行：把 Git LFS 素材直接存到你自己的腾讯云 COS，**不需要任何服务端**。代码照常托管在 GitHub 等平台，模型、贴图、音频等大文件由 git-lfs 直传 COS。

```bash
npm install -g yunbox
```

需要 Node.js 22.18+、Git 2.30+ 和 git-lfs 3.2+。安装后同时得到 `yunbox` 和 `git-yunbox` 两个命令，`git yunbox <命令>` 和 `yunbox <命令>` 完全一样。

## 管理员：接入一个仓库

```bash
yunbox login        # 保存自己的腾讯云 SecretId / SecretKey（macOS 存进钥匙串）
git yunbox init     # 选择或新建私有 bucket，填目录前缀，自动检查读写权限
git add .gitattributes .yunbox/config
git commit -m "chore: 用 YunBox 把 LFS 素材直传到 COS"
git push
```

给协作者开子账号时，用 `yunbox policy` 生成只覆盖这个前缀的最小权限策略（`--read-only` 生成只读策略），粘贴到腾讯云 CAM 控制台。

## 协作者

```bash
yunbox login                  # 用管理员分配给你的子账号密钥
git yunbox clone <仓库地址>    # clone 历史 + 登记传输代理 + 下载素材
```

## 常用命令

| 命令 | 作用 |
|---|---|
| `yunbox login` / `logout` | 保存 / 删除本机的腾讯云密钥。SecretKey 只从终端提示或标准输入读取 |
| `git yunbox init` | 接入仓库：`.gitattributes`、`.yunbox/config`（只有 bucket、地域、前缀，不含密钥）和本机的传输代理 |
| `git yunbox clone` | clone 一个已接入的仓库并下载素材 |
| `yunbox doctor` | 检查传输代理、密钥和 COS 读写权限，给出修复命令；`--json` 供图形界面使用 |
| `yunbox policy` | 输出子账号的最小权限 CAM 策略 |
| `yunbox buckets` | 列出本机密钥能看到的 bucket |
| `yunbox status` | Git / 素材目标、传输代理登记状态，以及本地 LFS 对象数量和大小 |
| `yunbox inspect --push` | 推送前检查 Git 和 LFS 的体积，逐个文件列出大小变化；`--confirm` 超限时弹窗确认 |
| `yunbox hook install` | 安装 pre-push 包装层：检查通过后才执行原有钩子（包括 git-lfs 上传） |
| `yunbox freeze set "Mo-Fr 09:00-18:00"` | 设置禁推时段（opening_hours 写法，可按星期、时区），时段内 pre-push 直接中断推送；`--shared` 写进 `.yunbox/config` 对团队生效 |

`git yunbox --help` 会被 Git 改写成 `git help yunbox`，查看帮助请用 `git yunbox help` 或 `yunbox --help`。

## 它是怎么工作的

git-lfs 不允许仓库自己指定传输程序，所以 `git yunbox init` 会在每份 clone 的 `.git/config` 里登记独立传输代理 `git-yunbox lfs-agent`。代理用本机密钥对 COS 请求签名，直接上传、下载：上传带 `x-cos-forbid-overwrite`，不会覆盖已有对象；下载时校验大小和 SHA-256，损坏或被替换的内容不会交给 git-lfs。没有服务端也就没有文件锁，同一素材同一时间请只由一人编辑。

更多说明见 [GitHub 仓库](https://github.com/YunLeFun/yunbox)。

## License

MIT

终端确认支持 Windows、Linux 和 macOS；`git config yunbox.confirmUI terminal` 可固定使用纯终端，`auto` 恢复自动选择。交互终端自动突出显示重点，`NO_COLOR=1` 关闭颜色；管道、CI 和 JSON 保持纯文本。更多说明见[常见问题](https://yunbox.yunle.fun/guide/faq)。

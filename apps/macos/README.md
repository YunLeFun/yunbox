# 云匣 YunBox · macOS 推送检查

SwiftUI 原生小工具，调用应用内附带的 YunBox CLI，复用同一套 Git/LFS 检查和 JSON 接口。需要 macOS 14+ 和本机 Node.js（版本要求同根项目）。

## 使用

- 选择或拖入 Git 仓库，检查 HEAD 相对本地 upstream 的已提交内容；没有 upstream 时检查全部历史并提示。
- 分别显示 Git pack 估算、LFS 候选量、预算、文件类型及超限状态；按文件大小降序，支持搜索、类型筛选、仅显示超限。
- 选中文件查看推送前后的变化：图片可并排、拖动分隔线或切换对比，文本显示 `git diff`，其他类型显示大小并可用「快速查看」打开（推送前后两个版本，左右方向键切换）。内容按对象 ID 从 Git 或本地 LFS 存储（`.git/lfs/objects`）读取，不读工作区；导出到仅当前用户可读的临时目录，切换仓库或退出时删除。本地没有的 LFS 旧版本无法对比。也可以复制路径或在 Finder 中定位当前仍存在的文件。
- 一键复制完整 JSON；最近仓库、运行环境和可选预算覆盖保存在本机偏好设置中。
- 最近仓库最多 12 个，前 9 个可用 `⌘1`–`⌘9` 切换，也可以从「文件 → 最近的仓库」菜单切换。再次打开已在列表里的仓库不会改变顺序，所以同一个快捷键始终对应同一个仓库；新仓库排在最前，超出 12 个时去掉最早加入的。
- 每个仓库最近一次的检查结果缓存在 `~/Library/Application Support/YunBox/InspectionCache`（CLI 原始 JSON 加检查时间）。切换仓库时先显示缓存，顶部提示「正在重新检查，先显示上次的结果」，后台重新检查完成后替换；重新检查失败时保留缓存并显示原因。缓存用和实时结果相同的校验读取，CLI 接口版本不兼容的缓存会被忽略；从最近列表移除的仓库，缓存一并删除。
- 仓库标题右侧显示 COS 直连状态（「直连 COS · 正常」「需要处理」「未接入 COS」），点击打开检查面板：逐项列出 `yunbox doctor --json` 的结果和修复命令；未接入时可以在面板里选择已有 bucket 或新建私有 bucket（会再次确认）、填写目录前缀，一键运行 `git yunbox init`；本机没有密钥时可以在面板里保存子账号密钥（SecretKey 用安全输入框，只经标准输入交给 `yunbox login`，不出现在命令行参数里）。切换仓库会自动重新检查。
- 检查在后台执行，可取消；切换仓库会取消旧任务，旧结果不会覆盖新仓库。进程有 120 秒时限和 64 MiB 输出上限。

快捷键：`⌘O` 选择仓库、`⌘1`–`⌘9` 切换最近的仓库、`⌘R` 重新检查、`⌘.` 取消、`⇧⌘C` 复制 JSON、`⌘,` 打开设置。

LFS 显示**候选上传量**，实际上传量保持未知；文件原始大小与 Git 压缩上传量不同。窗口中的检查与实际 pre-push 时收到的引用范围可能不同，最终推送仍由 [CLI / Workstation 钩子](../../docs/inspect.md) 按实际引用重新检查。

## 构建、启动、安装

在仓库根目录，先安装依赖；还需 Xcode 或包含 Swift 6 的开发工具：

```bash
pnpm install
./script/build_and_run.sh             # 构建 CLI + 原生程序，生成 .app 后打开
./script/build_and_run.sh --verify    # 同上，并检查进程已启动
./script/build_and_run.sh --install   # 安装到 ~/Applications/YunBox.app 并打开
./script/build_and_run.sh --build     # 只生成 dist/YunBox.app
```

Codex 的 Run 按钮也调用此脚本。`--logs` / `--telemetry` 打开应用并查看进程日志；`--debug` 用 LLDB 调试 bundle 内的二进制。

构建脚本把 CLI 组件复制进 `.app`，记录构建时的 Node.js 路径，不打包整个 Node.js 运行时；路径失效时查找 PATH / Homebrew，或在设置中选择新的 node 可执行文件。Finder 启动无需交互式 shell 配置。更新 CLI 代码后需要重新构建客户端。

应用图标源自 `assets/brand`，是 [YunLeFun/icons](https://github.com/YunLeFun/icons) 中 `assets/apps/yunbox/v1` 的固定副本，以 `manifest.json` 的 SHA-256 校验。Xcode 26+ 下，脚本用 `actool` 把分层的 `YunBox.icon` 编译进 `Assets.car` 并写入 `CFBundleIconName`，macOS 26 据此显示默认、深色、Clear 与着色外观；同时由 `yunbox-app-icon.svg` 渲染 `AppIcon.icns` 作为旧系统兜底。更新图标时先改中心仓库，再运行 `pnpm icons:sync --source /path/to/icons`；`pnpm icons:check` 只校验本地副本。

当前是 ad-hoc 签名构建，尚未完成 Developer ID 签名和公证。发布版本时，`Release` 工作流用 `YUNBOX_SWIFT_BUILD_ARGS="-c release --arch arm64 --arch x86_64"` 构建通用二进制，打包成 `YunBox-macOS.zip` 附在 GitHub release 上，官网的下载按钮指向它；第一次打开需要在「系统设置 → 隐私与安全性」里放行。`Info.plist` 的版本号取自 `packages/cli/package.json`。`dist/`、Swift 构建缓存及本机运行路径均不提交。

## 验证

```bash
swift build --package-path apps/macos
YUNBOX_TEST_NODE="$(node -p 'process.execPath')" \
YUNBOX_TEST_CLI="$PWD/packages/cli/dist/cli.mjs" \
swift test --package-path apps/macos
```

测试覆盖退出码与 JSON 一致性、LFS 未知上传量、历史路径、取消和超时、输出限制、参数传递、最近列表的顺序和上限、缓存的读写和清理（包括忽略不兼容的缓存），以及真实 Git 仓库通过 CLI 返回超限报告。真实 CLI 测试需要上面的两个环境变量。CI 在 macOS 上构建 CLI、运行 Swift 测试并检查 `.app` 打包。

## 结构

- `YunBoxKit`：JSON 模型、进程执行与 CLI 调用、按对象 ID 读取推送版本（`ContentReader`）、最近仓库列表和检查结果缓存，可独立测试。
- `YunBoxDesktop/App`：窗口、菜单、启动行为。
- `YunBoxDesktop/Stores`：仓库选择、检查状态及最近列表。
- `YunBoxDesktop/Views`：列表、预算概览、文件明细及设置。
